import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from './config.js'
import { migrate } from './migrations.js'
import { Store } from './store.js'
import { SyncService } from './sync.js'
import { createApp } from './app.js'
import type { Extractor } from './harness.js'
import type { SourceMessage, Cursor } from './records.js'

const enabled = process.env.RUN_DATABASE_TESTS === 'true'
let pool: Pool, store: Store, sync: SyncService, app: FastifyInstance, directory: string
let calls = 0, shouldFail = false
const fake: Extractor = {
  async extract(messages, _context, tasks) {
    calls++; if (shouldFail) throw new Error('模型输出未通过校验')
    const known = tasks.find((task) => task.source !== 'manual')
    return [{ ...(known ? { taskId: known.id } : {}), title: '修复登录接口', status: messages.some((message) => message.text.includes('已完成')) ? 'completed' : 'todo', evidenceIds: [messages.at(-1)!.id] }]
  }, async close() {},
}
async function waitRun() {
  const run = await sync.trigger()
  for (let attempt = 0; attempt < 300; attempt++) {
    const saved = await store.run(run.id)
    if (saved?.status !== 'running') return saved!
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('同步测试超时')
}
describe.skipIf(!enabled).sequential('PostgreSQL与工作台接口', () => {
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.includes('_test')) throw new Error('禁止使用业务数据库运行测试')
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 })
    await migrate(pool); await migrate(pool)
    store = new Store(pool)
    directory = await mkdtemp(join(tmpdir(), 'workbench-db-'))
    for (const name of ['codex', 'archive', 'claude']) await mkdir(join(directory, name))
    const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, CODEX_SESSIONS_DIR: join(directory, 'codex'), CODEX_ARCHIVE_DIR: join(directory, 'archive'), CLAUDE_PROJECTS_DIR: join(directory, 'claude'), SYNC_ENABLED: 'false', STATIC_DIR: join(directory, 'no-static') })
    sync = new SyncService(store, config, fake); await sync.start(); app = await createApp(config, store, sync)
  })
  afterAll(async () => { await app?.close(); await sync?.close(); await pool?.end(); if (directory) await rm(directory, { recursive: true, force: true }) })
  it('数据库持久化、重复完成与恢复未完成', async () => {
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200)
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: '手工测试事项' } })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    const done = (await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { completed: true } })).json()
    const repeat = (await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { completed: true } })).json()
    expect(repeat.completedAt).toBe(done.completedAt)
    const reopened = (await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { completed: false } })).json()
    expect(reopened.completedAt).toBeNull(); expect(reopened.statusOrigin).toBe('manual')
    const other = new Store(pool); expect((await other.tasks()).some((task) => task.id === id)).toBe(true)
  })
  it('旧记录保留完成日期、重复导入不覆盖新状态，示例被拒绝', async () => {
    const task = { id: randomUUID(), reference: 'TASK-old', source: 'manual', title: '旧手工记录', createdAt: '2026-09-01T01:00:00Z', completedAt: '2026-09-02T01:00:00Z' }
    expect((await app.inject({ method: 'POST', url: '/api/tasks/import', payload: { tasks: [task] } })).json().imported).toBe(1)
    expect((await store.tasks()).find((row) => row.id === task.id)?.completedAt).toBe('2026-09-02T01:00:00.000Z')
    await store.setCompleted(task.id, false)
    expect((await app.inject({ method: 'POST', url: '/api/tasks/import', payload: { tasks: [task] } })).json().duplicates).toBe(1)
    expect((await store.tasks()).find((row) => row.id === task.id)?.completedAt).toBeNull()
    expect((await app.inject({ method: 'POST', url: '/api/tasks/import', payload: { tasks: [{ ...task, id: 'demo-pending-1', source: 'codex' }] } })).statusCode).toBe(400)
  })
  it('输入校验和跨站写入拦截', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: '' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'x'.repeat(301) } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/tasks', headers: { origin: 'https://foreign.example' }, payload: { title: '事项' } })).statusCode).toBe(403)
  })
  it('首次抽取、重复同步、后续完成以及手动状态保护', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`
    const file = join(directory, 'codex', `rollout-${id}.jsonl`)
    const at = new Date().toISOString()
    await writeFile(file, [
      { type: 'session_meta', timestamp: at, payload: { id, cwd: project } },
      { type: 'turn_context', timestamp: at, payload: { turn_id: '1' } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请修复登录接口' }] } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const first = await waitRun(); expect(first.newTasks).toBe(1)
    const task = (await store.projectTasks(project))[0]; expect(task.completedAt).toBeNull()
    const callsBefore = calls; const repeat = await waitRun(); expect(repeat.newMessages).toBe(0); expect(calls).toBe(callsBefore)
    await appendFile(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成接口修复并通过测试' }] } }) + '\n')
    await waitRun(); expect((await store.projectTasks(project))[0].completedAt).not.toBeNull()
    await store.setCompleted(task.id, false)
    await appendFile(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成回归，确认接口修复交付' }] } }) + '\n')
    await waitRun(); expect((await store.projectTasks(project))[0].completedAt).toBeNull()
    expect((await store.projectTasks(project))[0].statusOrigin).toBe('manual')
    expect(await store.projectTasks(project)).toHaveLength(1)
  })
  it('事务回滚不丢消息，成功重试后重复应用无副作用', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`
    const message: SourceMessage = { id: randomUUID(), source: 'claude', sessionId: id, rootSessionId: id, projectPath: project, role: 'user', timestamp: new Date().toISOString(), text: '整理测试报告' }
    const cursor: Cursor = { path: `fixture:${id}`, source: 'claude', inode: '1', offset: 1, modifiedAt: 1, context: { sessionId: id, projectPath: project, parentSessionId: null, turnId: '' } }
    await store.ingest([message], cursor)
    const batchId = store.batchId([message]); await store.startBatch(batchId, `claude:${id}`, [message])
    const item = { title: '整理测试报告', status: 'todo' as const, evidenceIds: [message.id] }
    await expect(store.applyExtraction(batchId, [message], [], [item, { ...item, title: '无效事项', evidenceIds: ['unknown'] }])).rejects.toThrow()
    expect(await store.projectTasks(project)).toHaveLength(0)
    expect((await store.pendingMessages()).some((entry) => entry.id === message.id)).toBe(true)
    expect((await store.applyExtraction(batchId, [message], [], [item])).created).toBe(1)
    expect(await store.applyExtraction(batchId, [message], [], [item])).toEqual({ created: 0, updated: 0 })
  })
  it('失败批次保留进度，下轮重试且并发触发不重叠', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`
    await writeFile(join(directory, 'claude', `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { content: '修复登录接口' } }) + '\n')
    shouldFail = true; const failed = await waitRun(); expect(failed.status).toBe('partial_failed'); expect(failed.failedBatches).toBe(1)
    shouldFail = false
    const [one, two] = await Promise.all([sync.trigger(), sync.trigger()]); expect(one.id).toBe(two.id)
    const succeeded = await waitRun(); expect(succeeded.status).toBe('succeeded'); expect(await store.projectTasks(project)).toHaveLength(1)
  })
  it('整理简介只更新标题，保护手工事项、日期、证据和并发改动', async () => {
    const original = (await store.tasks()).find((task) => task.source !== 'manual' && task.statusOrigin === 'ai')!
    const manual = (await store.tasks()).find((task) => task.source === 'manual')!
    const rowsBefore = (await pool.query('SELECT count(*) FROM workbench.source_messages WHERE extracted')).rows[0].count
    expect(await store.applySummaries([original, manual], [
      { taskId: original.id, title: '完善测试报告，汇总验证结果' }, { taskId: manual.id, title: '不应覆盖手工标题' },
    ])).toBe(1)
    const changed = (await store.tasks()).find((task) => task.id === original.id)!
    expect({ ...changed, title: original.title }).toEqual(original)
    expect((await store.tasks()).find((task) => task.id === manual.id)).toEqual(manual)
    expect(await store.applySummaries([original], [{ taskId: original.id, title: '过期结果' }])).toBe(0)
    await store.setCompleted(changed.id, false)
    expect(await store.applySummaries([changed], [{ taskId: changed.id, title: '不应覆盖用户改动' }])).toBe(0)
    expect((await pool.query('SELECT count(*) FROM workbench.source_messages WHERE extracted')).rows[0].count).toBe(rowsBefore)
  })
})
