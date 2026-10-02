import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from './config.js'
import { migrate } from './migrations.js'
import { Store } from './store.js'
import { SyncService } from './sync.js'
import { createApp } from './app.js'
import type { Extractor } from './harness.js'
import type { SourceMessage, Cursor } from './records.js'
import { dateKey, recordsForDate } from '../src/domain/workbench.js'
import { DailyReportService } from './dailyReport.js'
import { isRecordInReport } from '../shared/dailyReports.js'

const enabled = process.env.RUN_DATABASE_TESTS === 'true'
let pool: Pool, store: Store, sync: SyncService, app: FastifyInstance, directory: string
let calls = 0, shouldFail = false
const reportInputs: string[][] = []
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
    for (const name of ['codex', 'archive', 'claude', 'workbuddy', 'zcode', 'gemini']) await mkdir(join(directory, name))
    const zcode = new DatabaseSync(join(directory, 'zcode', 'db.sqlite'))
    zcode.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`)
    zcode.close()
    const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, CODEX_SESSIONS_DIR: join(directory, 'codex'), CODEX_ARCHIVE_DIR: join(directory, 'archive'), CLAUDE_PROJECTS_DIR: join(directory, 'claude'), WORKBUDDY_PROJECTS_DIR: join(directory, 'workbuddy'), ZCODE_DB_DIR: join(directory, 'zcode'), GEMINI_SESSIONS_DIR: join(directory, 'gemini'), SYNC_ENABLED: 'false', STATIC_DIR: join(directory, 'no-static') })
    const reports = new DailyReportService(store, { async generateDailyReport(_day, records, previous) {
      reportInputs.push(records.map((task) => task.id))
      return [{ text: '完善测试计划，汇总相关工作进展。', topic: '测试计划', taskIds: [...new Set([...(previous?.items.flatMap((item) => item.taskIds) ?? []), ...records.map((task) => task.id)])] }]
    }, async close() {} })
    sync = new SyncService(store, config, fake); await sync.start(); app = await createApp(config, store, sync, reports)
  })
  afterAll(async () => { await app?.close(); await sync?.close(); await pool?.end(); if (directory) await rm(directory, { recursive: true, force: true }) })
  it('旧自动记录按来源时间迁移，保留原完成状态并可重复执行迁移', async () => {
    const id = randomUUID(), at = '2026-09-25T03:20:00Z'
    const evidence = [{ messageId: 'legacy', sessionId: 'legacy', source: 'codex', projectPath: '/legacy', timestamp: at, quote: '整理工作记录' }]
    // 仅在隔离测试库模拟第一版结构，验证升级不会把历史记录归到同步当天。
    await pool.query('ALTER TABLE workbench.tasks DROP COLUMN recorded_at')
    await pool.query('DELETE FROM workbench.schema_migrations WHERE version=2')
    await pool.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,evidence)
      VALUES($1,'CX-legacy','codex','整理工作记录',$2,$3)`, [id, '2026-09-24T01:00:00Z', JSON.stringify(evidence)])
    await migrate(pool); await migrate(pool)
    const task = (await store.tasks()).find((row) => row.id === id)!
    expect(task.recordedAt).toBe('2026-09-25T03:20:00.000Z')
    expect(task.completedAt).toBeNull()
    expect(task.evidence).toEqual(evidence)
  })
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
  it('日报持久化，重复打开不生成，补充只整理新日志且保存版本防止覆盖', async () => {
    const day = '2026-08-20'
    const original = { id: randomUUID(), reference: 'TASK-report', source: 'manual' as const, title: '完善测试计划展示', createdAt: `${day}T01:00:00Z`, completedAt: `${day}T02:00:00Z` }
    await store.importTasks([original])
    expect((await app.inject({ url: `/api/daily-reports/${day}` })).json()).toBeNull()
    const first = (await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day } })).json()
    expect(first.revision).toBe(1); expect(first.recordCount).toBe(1)
    const other = new Store(pool)
    expect((await other.reportRecords(day)).every((task) => task.evidence === undefined)).toBe(true)
    expect(await other.dailyReport(day)).toEqual(first)
    expect((await sync.snapshot()).dailyReports).toContainEqual(first)
    const added = { ...original, id: randomUUID(), title: '补充测试计划导出' }
    await store.importTasks([added])
    const count = reportInputs.length
    expect((await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day } })).json()).toEqual(first)
    expect(reportInputs).toHaveLength(count)
    const second = (await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day, mode: 'append' } })).json()
    expect(second.revision).toBe(2); expect(second.recordCount).toBe(2)
    expect(reportInputs.at(-1)).toEqual([added.id])
    const logged = recordsForDate({ version: 1, tasks: await other.tasks() }, day)
    expect(logged.every((task) => isRecordInReport(task, second))).toBe(true)
    expect(await other.saveDailyReport({ ...first, revision: 2 }, 1)).toBeNull()
    expect(await other.dailyReport(day)).toEqual(second)
    expect((await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day, mode: 'append' } })).json()).toEqual(second)
    expect(reportInputs).toHaveLength(count + 1)
  })
  it('自动记录按来源日期归档、重复同步不再抽取、仅新增消息更新', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`
    const file = join(directory, 'codex', `rollout-${id}.jsonl`)
    const at = new Date(Date.now() - 2 * 86400000).toISOString()
    await writeFile(file, [
      { type: 'session_meta', timestamp: at, payload: { id, cwd: project } },
      { type: 'turn_context', timestamp: at, payload: { turn_id: '1' } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请修复登录接口' }] } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const first = await waitRun(); expect(first.newTasks).toBe(1)
    const task = (await store.projectTasks(project))[0]; expect(task.completedAt).toBeNull()
    expect(task.recordedAt).toBe(at)
    expect(recordsForDate({ version: 1, tasks: [task] }, dateKey(new Date(at)))).toHaveLength(1)
    const callsBefore = calls; const repeat = await waitRun(); expect(repeat.newMessages).toBe(0); expect(calls).toBe(callsBefore)
    await appendFile(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成接口修复并通过测试' }] } }) + '\n')
    await waitRun(); expect((await store.projectTasks(project))[0].completedAt).not.toBeNull()
    const rejected = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { completed: false } })
    expect(rejected.statusCode).toBe(409)
    await appendFile(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成回归，确认接口修复交付' }] } }) + '\n')
    await waitRun(); expect((await store.projectTasks(project))[0].completedAt).not.toBeNull()
    expect((await store.projectTasks(project))[0].statusOrigin).toBe('ai')
    expect(await store.projectTasks(project)).toHaveLength(1)
  })
  it('Gemini会话与快照直接归档，重复同步不抽取，新回复更新记录和来源证据', async () => {
    const id = randomUUID(), project = `/__workbench_gemini_test__/${id}`
    const projectDirectory = join(directory, 'gemini', id), chats = join(projectDirectory, 'chats')
    await mkdir(chats, { recursive: true }); await writeFile(join(projectDirectory, '.project_root'), project)
    const file = join(chats, `session-${id}.jsonl`), at = new Date(Date.now() - 2 * 86400000).toISOString()
    const user = { id: 'u1', type: 'user', timestamp: at, content: [{ text: '修复登录接口' }] }
    await writeFile(file, [{ sessionId: id, projectHash: id, startTime: at }, user, { $set: { messages: [user] } }].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const first = await waitRun()
    expect(first.newMessages).toBe(1); expect(first.newTasks).toBe(1)
    const task = (await store.projectTasks(project))[0]
    expect(task.source).toBe('gemini'); expect(task.reference).toMatch(/^GM-/)
    expect(task.recordedAt).toBe(at); expect(task.completedAt).toBeNull()
    expect(task.evidence?.[0]).toMatchObject({ source: 'gemini', sessionId: id, projectPath: project })
    expect(recordsForDate({ version: 1, tasks: [task] }, dateKey(new Date(at)))).toEqual([task])
    expect((await sync.snapshot()).sources.gemini).toMatchObject({ available: true, sessionCount: 1, error: null })
    const previousCalls = calls
    expect((await waitRun()).newMessages).toBe(0); expect(calls).toBe(previousCalls)
    await appendFile(file, JSON.stringify({ $set: { messages: [user] } }) + '\n')
    expect((await waitRun()).newMessages).toBe(0); expect(calls).toBe(previousCalls)
    const assistant = { id: 'a1', type: 'gemini', timestamp: new Date().toISOString(), content: [{ text: '已完成登录接口修复与测试' }] }
    await appendFile(file, JSON.stringify(assistant) + '\n')
    const updated = await waitRun()
    expect(updated.newMessages).toBe(1); expect(updated.updatedTasks).toBe(1)
    const current = (await store.projectTasks(project))[0]
    expect(current.completedAt).not.toBeNull(); expect(current.evidence).toHaveLength(2)
    expect(current.recordedAt).toBe(assistant.timestamp)
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { completed: false } })).statusCode).toBe(409)
    expect((await waitRun()).newMessages).toBe(0)
  })
  it('Zcode会话直接归档、重复同步去重、WAL中的新回复更新事项与来源证据', async () => {
    const id = randomUUID(), project = `/__workbench_zcode_test__/${id}`
    const database = new DatabaseSync(join(directory, 'zcode', 'db.sqlite'))
    try {
      database.exec('PRAGMA journal_mode=WAL')
      const at = Date.now() - 2 * 86400000, userId = randomUUID(), assistantId = randomUUID()
      database.prepare('INSERT INTO session VALUES(?,?,?)').run(id, project, null)
      const insertMessage = database.prepare('INSERT INTO message VALUES(?,?,?,?,?)')
      const insertPart = database.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)')
      insertMessage.run(userId, id, at, at, JSON.stringify({ role: 'user' }))
      insertPart.run(randomUUID(), userId, id, at, at, JSON.stringify({ type: 'text', text: '修复登录接口' }))
      const first = await waitRun()
      expect(first.newMessages).toBe(1); expect(first.newTasks).toBe(1)
      const task = (await store.projectTasks(project))[0]
      expect(task.source).toBe('zcode'); expect(task.reference).toMatch(/^ZC-/)
      expect(task.recordedAt).toBe(new Date(at).toISOString()); expect(task.completedAt).toBeNull()
      expect(task.evidence?.[0]).toMatchObject({ source: 'zcode', sessionId: id, projectPath: project })
      expect(recordsForDate({ version: 1, tasks: [task] }, dateKey(new Date(at)))).toEqual([task])
      expect((await sync.snapshot()).sources.zcode).toMatchObject({ available: true, sessionCount: 1, error: null })
      const previousCalls = calls
      expect((await waitRun()).newMessages).toBe(0); expect(calls).toBe(previousCalls)
      const started = Date.now()
      insertMessage.run(assistantId, id, started, started, JSON.stringify({ role: 'assistant', time: { created: started } }))
      const partId = randomUUID()
      insertPart.run(partId, assistantId, id, started, started, JSON.stringify({ type: 'text', text: '正在修复' }))
      expect((await waitRun()).newMessages).toBe(0); expect(calls).toBe(previousCalls)
      const ended = started + 100
      database.prepare('UPDATE part SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({ type: 'text', text: '已完成登录接口修复并通过测试' }), ended, partId)
      database.prepare('UPDATE message SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({ role: 'assistant', time: { created: started, completed: ended } }), ended, assistantId)
      const updated = await waitRun()
      expect(updated.newMessages).toBe(1); expect(updated.updatedTasks).toBe(1)
      const result = (await store.projectTasks(project))[0]
      expect(result.evidence).toHaveLength(2); expect(result.completedAt).toBe(new Date(started).toISOString())
      expect(await store.projectTasks(project)).toHaveLength(1)
      expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { completed: true } })).statusCode).toBe(409)
      expect((await waitRun()).newMessages).toBe(0)
    } finally { database.close() }
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
    expect(await store.startBatch(batchId, `claude:${id}`, [message])).toBe(false)
    expect((await pool.query('SELECT attempts,status FROM workbench.extraction_batches WHERE id=$1', [batchId])).rows[0]).toEqual({ attempts: 1, status: 'succeeded' })
  })
  it('失败批次保留进度，下轮重试且并发触发不重叠', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`
    await writeFile(join(directory, 'claude', `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { content: '修复登录接口' } }) + '\n')
    shouldFail = true; const failed = await waitRun(); expect(failed.status).toBe('partial_failed'); expect(failed.failedBatches).toBe(1)
    shouldFail = false
    const [one, two] = await Promise.all([sync.trigger(), sync.trigger()]); expect(one.id).toBe(two.id)
    const succeeded = await waitRun(); expect(succeeded.status).toBe('succeeded'); expect(await store.projectTasks(project)).toHaveLength(1)
  })
  it('超大半行两次失败后持久忽略，追加完成后恢复且不重复抽取有效记录', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`, file = join(directory, 'claude', `${id}.jsonl`)
    const row = (text: string) => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { content: text } })
    await writeFile(file, row('有效事项') + '\n' + 'x'.repeat(5 * 1024 * 1024))
    const first = await waitRun()
    expect(first.status).toBe('partial_failed'); expect(first.newMessages).toBe(1)
    const second = await waitRun()
    expect(second.status).toBe('succeeded'); expect(second.ignoredFiles).toBe(1); expect(second.errors).toEqual([])
    const state = (await pool.query('SELECT fingerprint,attempts FROM workbench.record_failures WHERE path=$1', [file])).rows[0]
    expect(state.attempts).toBe(2)
    expect(await new Store(pool).recordIgnored(file, state.fingerprint)).toBe(true)
    const repeat = await waitRun()
    expect(repeat.status).toBe('succeeded'); expect(repeat.newMessages).toBe(0); expect(repeat.ignoredFiles).toBe(1)
    await appendFile(file, '\n' + row('追加有效事项') + '\n')
    const recovered = await waitRun()
    expect(recovered.status).toBe('succeeded'); expect(recovered.newMessages).toBe(1)
    expect(recovered.skippedRecords).toBe(1); expect(recovered.ignoredFiles).toBe(0)
    expect((await pool.query('SELECT 1 FROM workbench.record_failures WHERE path=$1', [file])).rowCount).toBe(0)
  })
  it('无法入库的坏日志只失败两次，文件修复后重新采集，同行有效文件不受影响', async () => {
    const id = randomUUID(), project = `/__workbench_test__/${id}`, file = join(directory, 'claude', `${id}.jsonl`)
    const content = (text: string) => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: project, timestamp: new Date().toISOString(), message: { content: text } }) + '\n'
    await writeFile(file, content('损坏\u0000内容'))
    expect((await waitRun()).status).toBe('partial_failed')
    expect((await waitRun()).ignoredFiles).toBe(1)
    expect((await store.cursor(file))).toBeNull()
    expect((await waitRun()).errors).toEqual([])
    await writeFile(file, content('已修复的有效内容'))
    const recovered = await waitRun()
    expect(recovered.status).toBe('succeeded'); expect(recovered.newMessages).toBe(1)
    expect(await store.projectTasks(project)).toHaveLength(1)
  })
  it('已跳过的坏行只作统计，数据库断连不会进入日志忽略清单', async () => {
    const id = randomUUID(), file = join(directory, 'claude', `${id}.jsonl`)
    await writeFile(file, '{损坏}\n' + JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: id, cwd: `/__workbench_test__/${id}`, timestamp: new Date().toISOString(), message: { content: '有效事项' } }) + '\n')
    const ingest = vi.spyOn(store, 'ingest').mockRejectedValueOnce(Object.assign(new Error('连接失败'), { code: '08006' }))
    try {
      expect((await waitRun()).status).toBe('failed')
      expect((await pool.query('SELECT 1 FROM workbench.record_failures WHERE path=$1', [file])).rowCount).toBe(0)
      expect(await store.cursor(file)).toBeNull()
    } finally { ingest.mockRestore() }
    const recovered = await waitRun()
    expect(recovered.status).toBe('succeeded'); expect(recovered.skippedRecords).toBe(1); expect(recovered.newMessages).toBe(1)
    expect(recovered.errors).toEqual([])
  })
  it('同轮失败不重复累计，文件版本变化与成功恢复会清理失败状态', async () => {
    const path = `fixture:${randomUUID()}`, run = randomUUID()
    expect(await store.failRecord(path, 'codex', 'v1', run)).toBe(1)
    expect(await store.failRecord(path, 'codex', 'v1', run)).toBe(1)
    expect(await store.failRecord(path, 'codex', 'v1', randomUUID())).toBe(2)
    expect(await new Store(pool).recordIgnored(path, 'v1')).toBe(true)
    expect(await store.recordIgnored(path, 'v2')).toBe(false)
    expect(await store.failRecord(path, 'codex', 'v2', randomUUID())).toBe(1)
    await store.clearRecordFailure(path)
    expect(await store.recordIgnored(path, 'v1')).toBe(false)
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
    // 模拟旧版本留下的人工状态，迁移后仍保护历史修改。
    await pool.query("UPDATE workbench.tasks SET status_origin='manual' WHERE id=$1", [changed.id])
    expect(await store.applySummaries([changed], [{ taskId: changed.id, title: '不应覆盖用户改动' }])).toBe(0)
    expect((await pool.query('SELECT count(*) FROM workbench.source_messages WHERE extracted')).rows[0].count).toBe(rowsBefore)
  })
})
