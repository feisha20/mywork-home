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
import { PeriodicReportScheduler } from './periodicReportScheduler.js'
import { PeriodicReportService } from './periodicReport.js'
import { isRecordInReport } from '../shared/dailyReports.js'
import { ZentaoV2Client, type ZentaoSnapshot, type ZentaoWorkItem } from './zentao.js'

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
    expect(await other.dailyReports(day, day)).toContainEqual(first)
    expect((await sync.snapshot()).dailyReports.every((report) => report.day === dateKey(new Date()))).toBe(true)
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
    // 用隔离库的真实 NOT NULL 约束模拟无法入库的正文；空字符已在采集时修复。
    await pool.query(`CREATE FUNCTION workbench.fixture_reject_message() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.body='损坏内容' THEN NEW.body=NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_message BEFORE INSERT ON workbench.source_messages FOR EACH ROW EXECUTE FUNCTION workbench.fixture_reject_message();`)
    try {
      await writeFile(file, content('损坏内容'))
      expect((await waitRun()).status).toBe('partial_failed')
      expect((await waitRun()).ignoredFiles).toBe(1)
      expect((await store.cursor(file))).toBeNull()
      expect((await waitRun()).errors).toEqual([])
      await writeFile(file, content('已修复的有效内容'))
      const recovered = await waitRun()
      expect(recovered.status).toBe('succeeded'); expect(recovered.newMessages).toBe(1)
      expect(await store.projectTasks(project)).toHaveLength(1)
    } finally {
      await pool.query('DROP TRIGGER fixture_reject_message ON workbench.source_messages; DROP FUNCTION workbench.fixture_reject_message();')
    }
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
  it('一份通用导出内的多个会话分别入库，父会话关联和解析器版本重启后保留', async () => {
    const source = 'custom-compatible-db' as const, path = `channel:${source}:${randomUUID()}`, timestamp = new Date().toISOString()
    const messages: SourceMessage[] = [
      { id: randomUUID(), source, sessionId: 'root', rootSessionId: 'root', projectPath: '/one', role: 'user', text: '父会话', timestamp },
      { id: randomUUID(), source, sessionId: 'child', rootSessionId: 'root', projectPath: '/one', role: 'assistant', text: '子会话', timestamp },
      { id: randomUUID(), source, sessionId: 'separate', rootSessionId: 'separate', projectPath: '/two', role: 'user', text: '另一项目', timestamp },
    ]
    const cursor: Cursor = { path, source, inode: 'fixture', offset: 100, modifiedAt: 1,
      context: { sessionId: 'separate', projectPath: '/two', parentSessionId: null, turnId: '', readerSignature: 'generic-fields-v1' } }
    try {
      expect(await store.ingest(messages, cursor)).toBe(3)
      const reloaded = new Store(pool)
      expect(await reloaded.resolveRoot(source, 'child')).toBe('root')
      expect(await reloaded.resolveRoot(source, 'separate')).toBe('separate')
      expect((await reloaded.cursor(path))?.context.readerSignature).toBe('generic-fields-v1')
      expect(await reloaded.ingest(messages, cursor)).toBe(0)
      expect((await reloaded.pendingMessages()).filter((message) => message.source === source)).toHaveLength(3)
    } finally {
      await pool.query('DELETE FROM workbench.source_messages WHERE source=$1', [source])
      await pool.query('DELETE FROM workbench.source_cursors WHERE path=$1', [path])
      await pool.query('DELETE FROM workbench.source_sessions WHERE source=$1', [source])
    }
  })
  it('周月报生成、人工编辑、重读与版本冲突形成数据库闭环', async () => {
    const url = '/api/periodic-reports/monthly/2026-08'
    expect((await app.inject({ url })).json()).toBeNull()
    const created = await app.inject({ method: 'POST', url, payload: { revision: 0 } })
    expect(created.statusCode).toBe(200)
    expect(created.json().revision).toBe(1)
    expect((await new Store(pool).periodicReport('monthly','2026-08'))?.markdown).toBe(created.json().markdown)
    const markdown = '# 我修改的月报\n\n人工确认的交付成果。'
    expect((await app.inject({ method: 'PUT', url, payload: { revision: 1, markdown } })).json().revision).toBe(2)
    expect((await app.inject({ url })).json()).toMatchObject({ markdown, edited: true, revision: 2 })
    expect((await app.inject({ method: 'PUT', url, payload: { revision: 1, markdown: '过期正文' } })).statusCode).toBe(409)
    const scheduler = new PeriodicReportScheduler(store, { subscribe: () => () => {} } as import('./settings.js').SettingsService)
    try {
      await scheduler.triggerMonthly('2026-08-31')
      expect((await store.periodicReport('monthly','2026-08'))?.markdown).toBe(markdown)
      await scheduler.triggerWeekly('2026-07-03')
      expect((await store.periodicReport('weekly','2026-W27'))?.revision).toBe(1)
    } finally { await scheduler.close() }
    for (const bad of ['/api/periodic-reports/weekly/2026-W99','/api/periodic-reports/monthly/2026-13']) expect((await app.inject({ url: bad })).statusCode).toBe(400)
  })
  it('旧优化自动稿恢复原版后仍保存到数据库，人工报告不覆盖', async () => {
    const service=new PeriodicReportService(store)
    const original=await service.generate('monthly','2026-06',0)
    const legacy={...original,markdown:'旧优化的项目拼接正文',sourceVersion:'本地测试版本'}
    await store.savePeriodicReport(legacy,1)
    const before=await store.periodicReport('monthly','2026-08')
    await service.restoreOriginalFormat()
    expect(await new Store(pool).periodicReport('monthly','2026-06')).toMatchObject({revision:3,markdown:original.markdown})
    expect(await store.periodicReport('monthly','2026-08')).toEqual(before)
    await service.restoreOriginalFormat()
    expect((await store.periodicReport('monthly','2026-06'))?.revision).toBe(3)
  })
  it('来源正文编辑重置抽取版本，旧证据失效，新证据核对后恢复', async () => {
    const id = randomUUID(), project = `/__source_version__/${id}`, at = '2026-09-15T02:00:00Z'
    const message: SourceMessage = { id, source: 'zcode', sessionId: id, rootSessionId: id, projectPath: project, role: 'assistant', timestamp: at, text: '已完成旧方案' }
    const cursor: Cursor = { path: `version:${id}`, source: 'zcode', inode: '1', offset: 1, modifiedAt: 1, context: { sessionId: id, projectPath: project, parentSessionId: null, turnId: '' } }
    await store.ingest([message], cursor)
    const batch = store.batchId([message]); await store.startBatch(batch, id, [message])
    await store.applyExtraction(batch, [message], [], [{ title: '旧方案完成', status: 'completed', evidenceIds: [id] }])
    const task = (await store.projectTasks(project))[0]
    const edited = { ...message, text: '旧方案已撤销，正在调整新方案' }
    expect(await store.ingest([edited], cursor)).toBe(1)
    const changed = (await store.projectTasks(project))[0]
    expect(changed).toMatchObject({ evidenceStale: true, completedAt: null })
    expect(changed.evidence?.[0]).toMatchObject({ valid: false, invalidReason: 'edited' })
    const pending = (await store.pendingMessages(['zcode'])).find((entry) => entry.id === id)!
    expect(pending.bodyRevision).toBe(2); expect(pending.text).toBe(edited.text)
    const nextBatch = store.batchId([pending]); expect(nextBatch).not.toBe(batch)
    await store.startBatch(nextBatch, id, [pending])
    await store.applyExtraction(nextBatch, [pending], [], [{ taskId: task.id, title: '正在调整新方案', status: 'todo', evidenceIds: [id] }])
    const verified = (await store.projectTasks(project))[0]
    expect(verified).toMatchObject({ evidenceStale: false, title: '正在调整新方案' })
    expect(verified.evidence?.some((entry) => entry.valid === true && entry.quote === edited.text)).toBe(true)
    expect(await store.ingest([edited], cursor)).toBe(0)
  })
  it('完整快照撤回会使来源证据失效，半份快照不会撤回', async () => {
    const id = randomUUID(), project = `/__source_withdrawn__/${id}`
    const message: SourceMessage = { id, source: 'gemini', sessionId: id, rootSessionId: id, projectPath: project, role: 'assistant', timestamp: new Date().toISOString(), text: '已完成来源工作', originKey: id }
    const cursor: Cursor = { path: `visible:${id}`, source: 'gemini', inode: '1', offset: 100, modifiedAt: 1, context: { sessionId: id, projectPath: project, parentSessionId: null, turnId: '' } }
    await store.ingest([message], cursor, true)
    const batch = store.batchId([message]); await store.startBatch(batch, id, [message])
    await store.applyExtraction(batch, [message], [], [{ title: '完成来源工作', status: 'completed', evidenceIds: [id] }])
    await store.ingest([], cursor, false)
    expect((await store.projectTasks(project))[0].evidenceStale).toBe(false)
    await store.ingest([], cursor, true)
    const task = (await store.projectTasks(project))[0]
    expect(task).toMatchObject({ evidenceStale: true, completedAt: null })
    expect(task.evidence?.[0]).toMatchObject({ valid: false, invalidReason: 'withdrawn' })
    expect((await store.pendingMessages(['gemini'])).some((row) => row.id === id)).toBe(false)
    // 可见历史回退后又恢复相同正文时，也必须产生新的抽取版本。
    expect(await store.ingest([message],cursor,true)).toBe(1)
    const restored = (await store.pendingMessages(['gemini'])).find((row) => row.id === id)!
    expect(restored.bodyRevision).toBe(2)
    const restoredBatch = store.batchId([restored]); expect(restoredBatch).not.toBe(batch)
    expect(await store.startBatch(restoredBatch,id,[restored])).toBe(true)
    await store.applyExtraction(restoredBatch,[restored],[],[{ taskId:task.id,title:'恢复并确认来源工作',status:'completed',evidenceIds:[id] }])
    expect((await store.projectTasks(project))[0]).toMatchObject({ evidenceStale:false,completedAt:message.timestamp })

  })
  it('抽取保存时拒绝已变化来源，较旧进展不覆盖较新状态', async () => {
    const id = randomUUID(), project = `/__source_race__/${id}`
    const message: SourceMessage = { id, source: 'claude', sessionId: id, rootSessionId: id, projectPath: project, role: 'assistant', timestamp: '2026-09-18T02:00:00Z', text: '正在实施旧方案' }
    const cursor: Cursor = { path: `race:${id}`, source: 'claude', inode: '1', offset: 1, modifiedAt: 1, context: { sessionId: id, projectPath: project, parentSessionId: null, turnId: '' } }
    await store.ingest([message], cursor)
    const batch = store.batchId([message]); await store.startBatch(batch, id, [message])
    await store.ingest([{ ...message, text: '旧方案已变更' }], cursor)
    await expect(store.applyExtraction(batch, [message], [], [{ title: '过期方案', status: 'todo', evidenceIds: [id] }])).rejects.toThrow('来源正文已修改或撤回')
    expect(await store.projectTasks(project)).toHaveLength(0)
    const newer = { ...message, id: randomUUID(), timestamp: '2026-09-19T02:00:00Z', text: '已完成新方案' }
    await store.ingest([newer], cursor)
    const newBatch = store.batchId([newer]); await store.startBatch(newBatch, id, [newer])
    await store.applyExtraction(newBatch, [newer], [], [{ title: '完成新方案', status: 'completed', evidenceIds: [newer.id] }])
    const task = (await store.projectTasks(project))[0]
    const older = { ...message, id: randomUUID() }; await store.ingest([older], cursor)
    const oldBatch = store.batchId([older]); await store.startBatch(oldBatch, id, [older])
    await store.applyExtraction(oldBatch, [older], [], [{ taskId: task.id, title: '旧的进行中状态', status: 'todo', evidenceIds: [older.id] }])
    expect((await store.projectTasks(project))[0]).toMatchObject({ title: '完成新方案', completedAt: '2026-09-19T02:00:00.000Z' })
  })
  it('日历按日期分页不携带证据，首页只读取当日与待办，证据单独读取', async () => {
    const all = await store.recordPage({ startDate: '2026-09-15', endDate: '2026-09-19', limit: 1 })
    expect(all.total).toBeGreaterThan(1); expect(all.tasks).toHaveLength(1); expect(all.tasks[0].evidence).toBeUndefined()
    const second = await store.recordPage({ startDate: '2026-09-15', endDate: '2026-09-19', limit: 1, offset: 1 })
    expect(second.tasks[0].id).not.toBe(all.tasks[0].id)
    expect((await app.inject({ url: `/api/tasks/${all.tasks[0].id}/evidence` })).json().length).toBeGreaterThan(0)
    const snapshot = (await app.inject({ url: '/api/workbench' })).json()
    expect(snapshot.tasks.every((task: import('../src/domain/workbench.js').Task) => task.evidence === undefined)).toBe(true)
    expect(snapshot.recordedDays).toContain('2026-09-15')
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/records?startDate=2026-10-10&endDate=2026-10-01' })).statusCode).toBe(400)
  })
  it('正文版本更替保留旧引用，只有当前版本参与后续抽取', async () => {
    const id = randomUUID(), project = `/__origin_version__/${id}`, timestamp = '2026-09-17T02:00:00Z'
    const one: SourceMessage = { id:`${id}:1`,source:'custom-version',sessionId:id,rootSessionId:id,projectPath:project,role:'assistant',timestamp,text:'完成原方案',originKey:id }
    const cursor: Cursor = { path:`origin:${id}`,source:one.source,inode:'1',offset:1,modifiedAt:1,context:{sessionId:id,projectPath:project,parentSessionId:null,turnId:''} }
    await store.ingest([one],cursor)
    const batch=store.batchId([one]); await store.startBatch(batch,id,[one]); await store.applyExtraction(batch,[one],[],[{title:'完成原方案',status:'completed',evidenceIds:[one.id]}])
    const task=(await store.projectTasks(project))[0]
    const two={...one,id:`${id}:2`,text:'撤销原方案，正在继续处理'}
    await store.ingest([two],cursor)
    expect((await store.pendingMessages([one.source])).map((row) => row.id)).toEqual([two.id])
    expect((await store.projectTasks(project))[0].evidence?.[0]).toMatchObject({valid:false,invalidReason:'edited'})
    const next=store.batchId([two]); await store.startBatch(next,id,[two]); await store.applyExtraction(next,[two],[],[{taskId:task.id,title:'继续处理新方案',status:'todo',evidenceIds:[two.id]}])
    const verified=(await store.projectTasks(project))[0]
    expect(verified.evidenceStale).toBe(false); expect(verified.evidence?.filter((row) => row.valid)).toHaveLength(1)
  })
  it('自动任务跨实例领取互斥，租约恢复和手动重试保留执行结果', async () => {
    const id = `fixture:${randomUUID()}`
    const job: import('../shared/contracts.js').ReportJob = { id, kind: 'daily', day: '2026-09-20', periodKey: '2026-09-20', scheduledAt: '2026-09-20T10:00:00Z', status: 'pending', attempts: 0, error: null, finishedAt: null }
    await store.enqueueReportJobs([job], new Date().toISOString())
    await store.enqueueReportJobs([job], new Date().toISOString())
    expect(await store.claimReportJob(['monthly'],'disabled')).toBeNull()
    const [one,two] = await Promise.all([store.claimReportJob(['daily'],'one'),new Store(pool).claimReportJob(['daily'],'two')])
    expect([one,two].filter(Boolean)).toHaveLength(1)
    const token = one ? 'one' : 'two'
    await pool.query("UPDATE workbench.report_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[id])
    const recovered = await store.claimReportJob(['daily'],'recovered')
    expect(recovered?.attempts).toBe(2)
    await store.finishReportJob(id,token,'succeeded')
    expect((await store.reportJobs()).find((row) => row.id === id)?.status).toBe('running')
    await store.finishReportJob(id,'recovered','failed','本地测试错误')
    expect((await app.inject({ method: 'POST', url: `/api/report-jobs/${encodeURIComponent(id)}/retry`, payload: {} })).statusCode).toBe(200)
    expect((await store.claimReportJob(['daily'],'retry'))?.attempts).toBe(3)
    await store.finishReportJob(id,'retry','succeeded')
    expect(await store.retryReportJob(id)).toBe(false)
  })

  it('禅道待办在事务内去重更新，保留手动完成，完成日期归档，转派移除且异常回滚', async () => {
    const instance = `https://zentao-${randomUUID()}.example`, account = 'fixture'
    const item = (type: 'bug' | 'task', id: string, state: ZentaoWorkItem['state'] = 'pending'): ZentaoWorkItem => ({
      id: `zentao-fixture-${type}-${id}`, reference: `${type.toUpperCase()}-${id}`, title: `禅道测试${type}${id}`, createdAt: '2026-09-20T01:00:00Z', completedAt: null, state,
      zentao: { instance, account, type, id, status: type === 'bug' ? 'active' : 'doing', url: `${instance}/${type}-view-${id}.html`, priority: 2, project: '测试项目', deadline: null },
    })
    const bug = item('bug', randomUUID()), task = item('task', randomUUID()), history = item('task', randomUUID(), 'completed')
    const snapshot = (items: ZentaoWorkItem[]): ZentaoSnapshot => ({ instance, account, items, bugs: 1, tasks: 1 })
    expect(await store.applyZentaoSnapshot(snapshot([bug, task, history]))).toEqual({ created: 2, updated: 0 })
    expect((await store.tasks()).find((row) => row.id === history.id)).toBeUndefined()
    const originalBug = (await store.tasks()).find((row) => row.id === bug.id)!
    expect(await store.applySummaries([originalBug], [{ taskId: bug.id, title: '不应改写禅道原始标题' }])).toBe(0)
    expect(await store.applyZentaoSnapshot(snapshot([bug, task, history]))).toEqual({ created: 0, updated: 0 })
    const beforeVersion = await store.dataVersion()
    const edited = { ...bug, title: '更新后的禅道标题', createdAt: '2026-09-21T01:00:00Z' }
    expect(await store.applyZentaoSnapshot(snapshot([edited, task]))).toEqual({ created: 0, updated: 1 })
    expect(await store.dataVersion()).not.toBe(beforeVersion)
    expect((await store.tasks()).find((row) => row.id === bug.id)).toMatchObject({ title: edited.title, createdAt: bug.createdAt.replace('Z', '.000Z'), zentao: bug.zentao })
    await expect(store.setCompleted(bug.id, true)).rejects.toThrow('禅道 Bug 状态由禅道系统驱动')
    const local = await store.setCompleted(task.id, true)
    await store.applyZentaoSnapshot(snapshot([edited, task]))
    expect((await store.tasks()).find((row) => row.id === task.id)?.completedAt).toBe(local?.completedAt)
    const closedBug = { ...edited, state: 'completed' as const, completedAt: '2026-10-06T09:30:00Z', zentao: { ...edited.zentao, status: 'closed' } }
    const done = { ...task, state: 'completed' as const, completedAt: '2026-10-05T08:20:00Z', zentao: { ...task.zentao, status: 'done' } }
    expect(await store.applyZentaoSnapshot(snapshot([closedBug, done]))).toEqual({ created: 0, updated: 2 })
    expect((await store.recordPage({ startDate: '2026-10-06', endDate: '2026-10-06' })).tasks.find((row) => row.id === bug.id)).toMatchObject({ completedAt: '2026-10-06T09:30:00.000Z', zentao: closedBug.zentao })
    expect((await store.tasks()).find((row) => row.id === task.id)).toMatchObject({ completedAt: local!.completedAt, zentao: done.zentao })
    expect(await store.applyZentaoSnapshot(snapshot([closedBug, done]))).toEqual({ created: 0, updated: 0 })
    await store.setCompleted(task.id, false)
    expect(await store.applyZentaoSnapshot(snapshot([]))).toEqual({ created: 0, updated: 0 })
    expect((await store.tasks()).some((row) => row.id === bug.id)).toBe(true)
    expect((await store.tasks()).some((row) => row.id === task.id)).toBe(true)
    // 重新指派给本人后恢复原编号；取消的待办不形成完成日志。
    await store.applyZentaoSnapshot(snapshot([edited, task]))
    expect((await store.tasks()).find((row) => row.id === bug.id)?.completedAt).toBeNull()
    expect((await store.tasks()).find((row) => row.id === task.id)?.completedAt).toBeNull()
    await store.applyZentaoSnapshot(snapshot([edited, { ...task, state: 'removed', zentao: { ...task.zentao, status: 'cancel' } }]))
    expect((await store.tasks()).some((row) => row.id === task.id)).toBe(false)
    const invalid = { ...item('bug', randomUUID()), title: '' }
    await expect(store.applyZentaoSnapshot(snapshot([{ ...edited, title: '不应保存的标题' }, invalid]))).rejects.toThrow()
    expect((await store.tasks()).find((row) => row.id === bug.id)?.title).toBe(edited.title)
    // 源为禅道的事项不作为会话模型可修改的既有任务。
    expect((await store.projectTasks('')).some((row) => row.source === 'zentao')).toBe(false)
  })
  it('三条待验证 Bug 关闭一条后保留两个待办，并恢复旧版误归档及误删除到关闭当日日志', async () => {
    const connection = { baseUrl: `https://zentao-${randomUUID()}.example`, account: 'fixture', password: '隔离测试密码' }
    const remoteBug = (id: number) => ({ id, title: `待验证 Bug ${id}`, status: 'resolved', assignedTo: connection.account,
      openedDate: '2026-09-20 17:39:38', resolvedDate: '2026-09-24 16:59:00', resolvedBy: '开发人员', deleted: '0' })
    const response = (data: unknown) => new Response(JSON.stringify(data))
    const mockApi = (ids: number[]) => {
      const fetch = vi.fn().mockResolvedValueOnce(response({ status: 'success', token: '隔离测试令牌' }))
        .mockResolvedValueOnce(response({ status: 'success', bugs: ids.map(remoteBug), pager: { recTotal: ids.length, recPerPage: 100, pageID: 1 } }))
        .mockResolvedValueOnce(response({ status: 'success', tasks: [], pager: { recTotal: 0, recPerPage: 100, pageID: 1 } }))
      vi.stubGlobal('fetch', fetch); return fetch
    }
    try {
      mockApi([1, 2, 3])
      const first = await new ZentaoV2Client(connection).readWork()
      expect(await store.applyZentaoSnapshot(first)).toEqual({ created: 3, updated: 0 })
      const ids = first.items.map((item) => item.id)
      // 重现旧版把他人的解决日期当成本人完成、把关闭后移出列表当作删除。
      await pool.query("UPDATE workbench.tasks SET zentao=zentao-'syncState',completed_at='2026-09-24T08:59:00Z' WHERE id=ANY($1::text[])", [ids.slice(0, 2)])
      await pool.query("UPDATE workbench.tasks SET zentao=zentao-'syncState',deleted_at=now() WHERE id=$1", [ids[2]])
      const tracked = await store.zentaoTrackedItems(connection.baseUrl, connection.account)
      expect(tracked).toHaveLength(3)
      const fetch = mockApi([1, 2])
      fetch.mockResolvedValueOnce(response({ status: 'success', bug: { ...remoteBug(3), status: 'closed', assignedTo: 'closed', closedBy: connection.account, closedDate: '2026-10-06 14:05:25' } }))
      const snapshot = await new ZentaoV2Client(connection).readWork(tracked)
      expect(await store.applyZentaoSnapshot(snapshot)).toEqual({ created: 0, updated: 3 })
      const own = (await store.snapshotTasks('2026-10-06')).filter((item) => item.zentao?.instance === connection.baseUrl)
      expect(own).toHaveLength(3)
      expect(own.filter((item) => !item.completedAt).map((item) => item.reference).sort()).toEqual(['BUG-1', 'BUG-2'])
      expect(own.find((item) => item.reference === 'BUG-3')).toMatchObject({ id: ids[2], completedAt: '2026-10-06T06:05:25.000Z' })
      expect((await store.reportRecords('2026-10-06')).filter((item) => ids.includes(item.id)).map((item) => item.reference)).toEqual(['BUG-3'])
      expect((await store.reportRecords('2026-09-24')).some((item) => ids.includes(item.id))).toBe(false)
      expect(await store.zentaoPendingCount(connection.baseUrl, connection.account)).toBe(2)
      expect(await store.applyZentaoSnapshot(snapshot)).toEqual({ created: 0, updated: 0 })
      expect(await store.zentaoTrackedItems(connection.baseUrl, connection.account)).toHaveLength(2)
      // 后续完整个人列表只有两个待办，不应移除已经归档的那条日志。
      mockApi([1, 2])
      expect(await store.applyZentaoSnapshot(await new ZentaoV2Client(connection).readWork(await store.zentaoTrackedItems(connection.baseUrl, connection.account)))).toEqual({ created: 0, updated: 0 })
      expect((await store.snapshotTasks('2026-10-06')).some((item) => item.id === ids[2])).toBe(true)
      const reassigned = { ...snapshot.items[0], state: 'removed' as const, zentao: { ...snapshot.items[0].zentao, status: 'active' } }
      await store.applyZentaoSnapshot({ ...snapshot, items: [reassigned] })
      expect(await store.zentaoTrackedItems(connection.baseUrl, connection.account)).toEqual([{ type: 'bug', id: '2' }])
      expect(await store.applyZentaoSnapshot({ ...snapshot, items: [reassigned] })).toEqual({ created: 0, updated: 0 })
    } finally { vi.unstubAllGlobals() }
  })
})
