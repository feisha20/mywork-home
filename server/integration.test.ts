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
import { ScheduledTasks } from './scheduledTasks.js'
import type { ScheduledTaskInput } from '../shared/scheduledTasks.js'
import { SyncService } from './sync.js'
import { createApp } from './app.js'
import type { Extractor } from './harness.js'
import type { SourceMessage, Cursor } from './records.js'
import { dateKey, pendingTasks, recordsForDate } from '../src/domain/workbench.js'
import { DailyReportService } from './dailyReport.js'
import { PeriodicReportScheduler } from './periodicReportScheduler.js'
import { PeriodicReportService } from './periodicReport.js'
import { isRecordInReport, reportRecordVersion } from '../shared/dailyReports.js'
import { ZentaoV2Client, type ZentaoSnapshot, type ZentaoWorkItem } from './zentao.js'
import { defaultZentaoManagement } from '../shared/zentaoManagement.js'
import { managementBatch, managementCase, valueDate } from './zentaoManagement.fixtures.js'

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
  it('计划接口支持持久化、编辑与删除，拒绝无效计划和不存在的编号', async () => {
    const input: ScheduledTaskInput = { title: '提交 OKR', frequency: 'monthly', time: '09:00', weekday: 5, day: 1, month: 1, quarterMonth: 1,
      startDate: '2090-01-01', endDate: null, enabled: true, isPersonal: false }
    expect((await app.inject({ method: 'POST', url: '/api/scheduled-tasks', payload: { ...input, time: '25:00' } })).statusCode).toBe(400)
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', payload: input })
    expect(created.statusCode).toBe(201)
    const plan = created.json()
    expect(plan.nextAt).toBe('2090-01-01T01:00:00.000Z')
    expect((await new ScheduledTasks(new Store(pool)).list()).some((item) => item.id === plan.id)).toBe(true)
    const edited = await app.inject({ method: 'PUT', url: `/api/scheduled-tasks/${plan.id}`, payload: { ...input, title: '审核部门 OKR', enabled: false } })
    expect(edited.json()).toMatchObject({ title: '审核部门 OKR', nextAt: null })
    expect((await app.inject({ url: '/api/scheduled-tasks' })).json().some((item: any) => item.id === plan.id)).toBe(true)
    expect((await app.inject({ method: 'DELETE', url: `/api/scheduled-tasks/${plan.id}`, payload: {} })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: `/api/scheduled-tasks/${plan.id}`, payload: input })).statusCode).toBe(404)
  })
  it('计划并发补齐、完成和删除不重复生成，暂停恢复和删除计划保留已有待办', async () => {
    const service = new ScheduledTasks(store)
    const input: ScheduledTaskInput = { title: '定期提交日报', frequency: 'daily', time: '09:00', weekday: 5, day: 1, month: 1, quarterMonth: 1,
      startDate: '2026-01-01', endDate: null, enabled: true, isPersonal: true }
    const plan = (await service.save(input, undefined, new Date('2026-01-01T00:00:00Z')))!
    const at = new Date('2026-01-03T01:00:00Z')
    await Promise.all([service.generateDue(at), new ScheduledTasks(new Store(pool)).generateDue(at)])
    const generated = (await store.tasks()).filter((task) => task.scheduledPlan?.id === plan.id)
    expect(generated).toHaveLength(3)
    expect(generated.every((task) => task.isPersonal && !task.completedAt && task.source === 'manual')).toBe(true)
    expect((await store.snapshotTasks('2026-01-03')).filter((task) => task.scheduledPlan?.id === plan.id)).toHaveLength(3)
    await store.setCompleted(generated[0].id, true)
    await store.deleteTask(generated[1].id)
    await service.generateDue(at)
    expect((await pool.query('SELECT count(*)::int AS count FROM workbench.scheduled_task_occurrences WHERE plan_id=$1', [plan.id])).rows[0].count).toBe(3)
    expect((await store.tasks()).filter((task) => task.scheduledPlan?.id === plan.id)).toHaveLength(2)
    await service.save({ ...input, enabled: false }, plan.id, at)
    await service.generateDue(new Date('2026-01-05T02:00:00Z'))
    expect((await service.list()).find((item) => item.id === plan.id)?.nextAt).toBeNull()
    const resumed = await service.save(input, plan.id, new Date('2026-01-06T02:00:00Z'))
    expect(resumed?.nextAt).toBe('2026-01-07T01:00:00.000Z')
    await service.generateDue(new Date('2026-01-07T01:00:00Z'))
    expect((await store.tasks()).filter((task) => task.scheduledPlan?.id === plan.id)).toHaveLength(3)
    await service.remove(plan.id)
    expect((await store.tasks()).filter((task) => task.scheduledPlan?.id === plan.id)).toHaveLength(3)
  })
  it('计划生成事务失败时待办和游标都回滚，重试后只生成一次', async () => {
    const service = new ScheduledTasks(store)
    const input: ScheduledTaskInput = { title: '事务回滚计划', frequency: 'daily', time: '09:00', weekday: 5, day: 1, month: 1, quarterMonth: 1,
      startDate: '2026-01-01', endDate: '2026-01-01', enabled: true, isPersonal: false }
    const plan = (await service.save(input, undefined, new Date('2026-01-01T00:00:00Z')))!
    const original = store.transaction.bind(store)
    vi.spyOn(store, 'transaction').mockImplementationOnce((action) => original(async (client) => { await action(client); throw new Error('模拟事务失败') }))
    await expect(service.generateDue(new Date('2026-01-01T02:00:00Z'))).rejects.toThrow('模拟事务失败')
    expect((await store.tasks()).filter((task) => task.scheduledPlan?.id === plan.id)).toHaveLength(0)
    expect((await service.list()).find((item) => item.id === plan.id)?.nextAt).toBe(plan.nextAt)
    await service.generateDue(new Date('2026-01-01T02:00:00Z'))
    expect((await store.tasks()).filter((task) => task.scheduledPlan?.id === plan.id)).toHaveLength(1)
    expect((await service.list()).find((item) => item.id === plan.id)?.nextAt).toBeNull()
    await service.remove(plan.id)
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
  it('多个禅道和自定义待办独立置顶，刷新和同步保留，取消后恢复正常排序', async () => {
    const manual = await store.createTask('置顶自定义待办')
    const other = await store.createTask('另一个置顶自定义待办')
    const instance = `https://pin-${randomUUID()}.example`, account = 'fixture'
    const items: ZentaoWorkItem[] = (['bug', 'task'] as const).map((type) => {
      const id = randomUUID()
      return { id, reference: `${type.toUpperCase()}-${id}`, title: `置顶禅道${type}`, createdAt: '2026-09-20T01:00:00Z', completedAt: null, state: 'pending',
        zentao: { instance, account, type, id, status: type === 'bug' ? 'active' : 'doing', url: `${instance}/${type}-view-${id}.html`, priority: 2, project: '测试项目', deadline: null } }
    })
    const snapshot: ZentaoSnapshot = { instance, account, items, bugs: 1, tasks: 1 }
    await store.applyZentaoSnapshot(snapshot)
    const ids = [manual.id, other.id, ...items.map((item) => item.id)]
    const pin = (id: string, isPinned: boolean) => app.inject({ method: 'PATCH', url: `/api/tasks/${id}/pin`, payload: { isPinned } })
    for (const id of ids) {
      const response = await pin(id, true)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ id, isPinned: true, completedAt: null })
    }
    expect((await pin(manual.id, true)).json()).toMatchObject({ isPinned: true })
    snapshot.items = items.map((item) => ({ ...item, title: item.title + '已更新' }))
    await new Store(pool).applyZentaoSnapshot(snapshot)
    const refreshed = (await app.inject({ url: '/api/workbench' })).json().tasks
    for (const id of ids) expect(refreshed.find((task: { id: string }) => task.id === id)).toMatchObject({ isPinned: true })
    const before = (await store.tasks()).find((task) => task.id === manual.id)!
    expect((await pin(manual.id, false)).json()).toMatchObject({ isPinned: false, title: before.title, createdAt: before.createdAt, completedAt: null, statusOrigin: before.statusOrigin })
    const reopened = await new Store(pool).tasks()
    const own = reopened.filter((task) => ids.includes(task.id))
    expect(pendingTasks(own).slice(0, 3).every((task) => task.isPinned)).toBe(true)
    expect(pendingTasks(own).at(-1)?.id).toBe(manual.id)
    await store.setCompleted(manual.id, true)
    expect(pendingTasks(await store.tasks()).some((task) => task.id === manual.id)).toBe(false)
  })
  it('置顶接口拒绝无效参数和非待办，不存在或已删除事项返回未找到', async () => {
    const manual = await store.createTask('校验置顶接口')
    const path = `/api/tasks/${manual.id}/pin`
    for (const payload of [{}, { isPinned: 'true' }, { isPinned: true, completed: true }]) {
      expect((await app.inject({ method: 'PATCH', url: path, payload })).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/missing/pin', payload: { isPinned: true } })).statusCode).toBe(404)
    await store.setCompleted(manual.id, true)
    expect((await app.inject({ method: 'PATCH', url: path, payload: { isPinned: true } })).statusCode).toBe(409)
    await store.setCompleted(manual.id, false)
    await pool.query("UPDATE workbench.tasks SET source='codex' WHERE id=$1", [manual.id])
    expect((await app.inject({ method: 'PATCH', url: path, payload: { isPinned: true } })).statusCode).toBe(409)
    await pool.query("UPDATE workbench.tasks SET source='manual' WHERE id=$1", [manual.id])
    await store.deleteTask(manual.id)
    expect((await app.inject({ method: 'PATCH', url: path, payload: { isPinned: false } })).statusCode).toBe(404)
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
  it('个人分类清理旧日报混合摘要，刷新自动周报并提示人工月报复核', async () => {
    const day = '2026-07-15', at = `${day}T03:00:00Z`
    const originals = ['完成项目交付', '安排家庭旅行', '完善另一个工作项目'].map((title) => ({
      id: randomUUID(), source: 'manual' as const, reference: 'TASK-private-fixture', title, createdAt: at, completedAt: at,
    }))
    await store.importTasks(originals)
    const normalized = await store.reportRecords(day)
    const initial = { day, generatedAt: at, revision: 1, recordCount: 3,
      recordVersions: Object.fromEntries(normalized.map((task) => [task.id, reportRecordVersion(task)])), items: [
        { text: '完成项目交付并安排家庭旅行', taskIds: originals.slice(0, 2).map((task) => task.id) },
        { text: '完善另一个工作项目', taskIds: [originals[2].id] },
      ] }
    expect(await store.saveDailyReport(initial, 0)).toEqual(initial)
    const weeklyPath = '/api/periodic-reports/weekly/2026-W29', monthlyPath = '/api/periodic-reports/monthly/2026-07'
    expect((await app.inject({ method: 'POST', url: weeklyPath, payload: { revision: 0 } })).json().markdown).toContain('家庭旅行')
    const manual = '# 人工月报\n完成项目交付并安排家庭旅行。'
    expect((await app.inject({ method: 'PUT', url: monthlyPath, payload: { revision: 0, markdown: manual } })).statusCode).toBe(200)
    const path = `/api/tasks/${originals[1].id}/personal`
    for (const payload of [{}, { isPersonal: 'true' }, { isPersonal: 1 }, { isPersonal: true, completed: false }]) {
      expect((await app.inject({ method: 'PATCH', url: path, payload })).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/missing/personal', payload: { isPersonal: true } })).statusCode).toBe(404)
    const marked = await app.inject({ method: 'PATCH', url: path, payload: { isPersonal: true } })
    expect(marked.statusCode).toBe(200)
    expect(marked.json()).toMatchObject({ isPersonal: true, personalOrigin: 'manual', title: originals[1].title, completedAt: '2026-07-15T03:00:00.000Z' })
    const other = new Store(pool)
    expect((await other.recordPage({ startDate: day, endDate: day, onlyRecords: true })).tasks.find((task) => task.id === originals[1].id)?.isPersonal).toBe(true)
    expect((await other.reportRecords(day)).map((task) => task.id).sort()).toEqual([originals[0].id, originals[2].id].sort())
    const cleaned = (await app.inject({ url: `/api/daily-reports/${day}` })).json()
    expect(cleaned).toMatchObject({ revision: 2, recordCount: 1, items: [initial.items[1]] })
    expect(cleaned.recordVersions).toEqual({ [originals[2].id]: initial.recordVersions[originals[2].id] })
    expect((await app.inject({ url: `/api/daily-reports/${day}/status` })).json()).toEqual({ recordCount: 2, unorganizedCount: 1 })
    const refreshed = (await app.inject({ url: weeklyPath })).json()
    expect(refreshed.markdown).not.toContain('家庭旅行')
    expect(refreshed.revision).toBe(3)
    expect(refreshed.stats.completedTasks).toBe(2)
    expect((await app.inject({ url: monthlyPath })).json()).toMatchObject({ markdown: manual, edited: true, needsRefresh: true, revision: 2 })
    const supplemented = await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day, mode: 'append' } })
    expect(supplemented.statusCode).toBe(200)
    expect(reportInputs.at(-1)).toEqual([originals[0].id])
    expect(supplemented.json().recordCount).toBe(2)
    expect((await app.inject({ method: 'PATCH', url: path, payload: { isPersonal: false } })).json().personalOrigin).toBe('manual')
    expect((await app.inject({ url: `/api/daily-reports/${day}/status` })).json().unorganizedCount).toBe(1)
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: '记下私人安排', isPersonal: true } })
    expect(created.json()).toMatchObject({ isPersonal: true, personalOrigin: 'manual', completedAt: null })
    const completed = (await app.inject({ method: 'PATCH', url: `/api/tasks/${created.json().id}`, payload: { completed: true } })).json()
    expect(completed.isPersonal).toBe(true)
    expect((await store.reportRecords(dateKey(new Date(completed.completedAt)))).some((task) => task.id === completed.id)).toBe(false)
  })
  it('所有会话来源保存 AI 分类，旧结果不覆盖新分类，手动双向改正仍允许 AI 更新进展', async () => {
    for (const source of ['codex', 'claude', 'workbuddy', 'zcode', 'gemini', 'custom-private'] as const) {
      const session = randomUUID(), projectPath = `/__personal_test__/${session}`
      const apply = async (index: number, isPersonal: boolean, taskId?: string) => {
        const message: SourceMessage = { id: `${session}:${index}`, sessionId: session, rootSessionId: session, projectPath, source,
          role: 'assistant', timestamp: `2026-05-12T0${index}:00:00Z`, text: `个人事项与进展测试 ${index}` }
        const cursor: Cursor = { path: `personal:${session}`, source, inode: '1', offset: index, modifiedAt: index,
          context: { sessionId: session, projectPath, parentSessionId: null, turnId: '' } }
        await store.ingest([message], cursor)
        const batch = store.batchId([message]); await store.startBatch(batch, session, [message])
        await store.applyExtraction(batch, [message], [], [{ taskId, title: '安排事项并确认执行结果', status: index >= 3 ? 'completed' : 'todo', isPersonal, evidenceIds: [message.id] }])
        return (await store.projectTasks(projectPath))[0]
      }
      let task = await apply(1, true)
      expect(task).toMatchObject({ source, isPersonal: true, personalOrigin: 'ai', statusOrigin: 'ai', completedAt: null })
      task = await apply(3, false, task.id)
      expect(task.isPersonal).toBe(false)
      task = await apply(2, true, task.id)
      expect(task.isPersonal).toBe(false)
      expect(task.recordedAt).toBe('2026-05-12T03:00:00.000Z')
      await store.setPersonal(task.id, true)
      task = await apply(4, false, task.id)
      expect(task).toMatchObject({ isPersonal: true, personalOrigin: 'manual', statusOrigin: 'ai', completedAt: '2026-05-12T04:00:00.000Z' })
      await store.setPersonal(task.id, false)
      task = await apply(5, true, task.id)
      expect(task).toMatchObject({ isPersonal: false, personalOrigin: 'manual', statusOrigin: 'ai', completedAt: '2026-05-12T05:00:00.000Z' })
      expect((await new Store(pool).recordPage({ startDate: '2026-05-12', endDate: '2026-05-12', onlyRecords: true })).tasks.find((item) => item.id === task.id)?.isPersonal).toBe(false)
    }
  })
  it('AI 将跨月推进的事项改为个人时，清理更早日报并刷新早期月报', async () => {
    const session = randomUUID(), source = 'codex', projectPath = `/__personal_history__/${session}`
    const apply = async (day: string, isPersonal: boolean, taskId?: string) => {
      const message: SourceMessage = { id: `${session}:${day}`, sessionId: session, rootSessionId: session, projectPath, source,
        role: 'assistant', timestamp: `${day}T03:00:00Z`, text: `确认事项实际用途 ${day}` }
      const cursor: Cursor = { path: `personal-history:${session}`, source, inode: '1', offset: 1, modifiedAt: Date.parse(message.timestamp),
        context: { sessionId: session, projectPath, parentSessionId: null, turnId: '' } }
      await store.ingest([message], cursor)
      const batch = store.batchId([message]); await store.startBatch(batch, session, [message])
      await store.applyExtraction(batch, [message], [], [{ taskId, title: '安排家庭旅行并确认行程', status: 'completed', isPersonal, evidenceIds: [message.id] }])
      return (await store.projectTasks(projectPath))[0]
    }
    const task = await apply('2026-03-17', false)
    await store.saveDailyReport({ day: '2026-03-17', generatedAt: task.createdAt, revision: 1, recordCount: 1,
      recordVersions: { [task.id]: reportRecordVersion(task) }, items: [{ text: '安排家庭旅行并确认行程', taskIds: [task.id] }] }, 0)
    const path = '/api/periodic-reports/monthly/2026-03'
    expect((await app.inject({ method: 'POST', url: path, payload: { revision: 0 } })).json().markdown).toContain('家庭旅行')
    await apply('2026-05-17', false, task.id)
    const personal = await apply('2026-06-17', true, task.id)
    expect(personal).toMatchObject({ isPersonal: true, personalOrigin: 'ai' })
    expect(await store.dailyReport('2026-03-17')).toMatchObject({ items: [], recordCount: 0, recordVersions: {}, revision: 2 })
    expect(await store.periodicReport('monthly', '2026-03')).toMatchObject({ needsRefresh: true, revision: 2 })
    expect((await app.inject({ url: path })).json().markdown).not.toContain('家庭旅行')
  })
  it('分类变化时拒绝保存生成中的日报和周月报，防止旧素材带回私人事项', async () => {
    const day = '2026-04-08', at = `${day}T03:00:00Z`
    const task = { id: randomUUID(), reference: 'TASK-race', source: 'manual' as const, title: '会被改为个人的事项', createdAt: at, completedAt: at }
    await store.importTasks([task])
    const reports = new DailyReportService(store, { async generateDailyReport(_day, records) {
      await store.setPersonal(task.id, true)
      return [{ text: '生成期间分类已变更的摘要', taskIds: records.map((item) => item.id) }]
    }, async close() {} })
    await expect(reports.generate(day)).rejects.toMatchObject({ statusCode: 409 })
    expect(await store.dailyReport(day)).toBeNull()
    await reports.close()
    await store.setPersonal(task.id, false)
    const periodic = new PeriodicReportService({
      periodTasks: store.periodTasks.bind(store), dailyReports: store.dailyReports.bind(store), periodicReport: store.periodicReport.bind(store), periodicReports: store.periodicReports.bind(store),
      savePeriodicReport: async (report, revision, scopes) => { await store.setPersonal(task.id, true); return store.savePeriodicReport(report, revision, scopes) },
    })
    await expect(periodic.generate('monthly', '2026-04', 0)).rejects.toMatchObject({ statusCode: 409 })
    expect(await store.periodicReport('monthly', '2026-04')).toBeNull()
  })
  it('管理待办重复同步不增项，人工完成跨重启和风险升级保留，解除后复发创建新一轮', async () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-10-07') }, { end: valueDate('2026-10-12') })
    batch.instance = 'https://management-' + randomUUID() + '.example'
    const own = async () => (await store.tasks()).filter((task) => task.management?.instance === batch.instance)
    expect((await store.management.apply(batch, defaultZentaoManagement)).created).toBe(1)
    expect((await store.management.apply(batch, defaultZentaoManagement)).created).toBe(0)
    const first = (await own())[0]
    const complete = await app.inject({ method: 'PATCH', url: '/api/tasks/' + first.id, payload: { completed: true } })
    expect(complete.statusCode).toBe(200)
    const completedAt = complete.json().completedAt
    const reopenedStore = new Store(pool)
    batch.collectedAt = '2026-10-08T04:00:00Z'
    expect((await reopenedStore.management.apply(batch, defaultZentaoManagement)).created).toBe(0)
    expect((await own())[0]).toMatchObject({ id: first.id, completedAt, management: { handlingState: 'completed', riskState: 'active', severity: 'red' } })
    expect((await store.management.page({ state: 'pending' }, { instance: batch.instance, account: batch.account })).total).toBe(0)
    batch.scopes[0].stories[0].plannedReleaseAt = valueDate('2026-10-20')
    await store.management.apply(batch, defaultZentaoManagement)
    expect((await own())[0].management).toMatchObject({ handlingState: 'completed', riskState: 'resolved', resolutionReason: '计划或关联范围已调整' })
    batch.scopes[0].stories[0].plannedReleaseAt = valueDate('2026-10-07')
    expect((await store.management.apply(batch, defaultZentaoManagement)).created).toBe(1)
    const fresh = (await own()).find((task) => task.management?.riskState === 'active')!
    expect(fresh.id).not.toBe(first.id)
    expect(fresh.management).toMatchObject({ occurrence: 2, handlingState: 'pending' })
    expect((await store.management.page({ state: 'completed' }, { instance: batch.instance, account: batch.account })).tasks[0].id).toBe(first.id)
    const donePage = await app.inject({ url: '/api/tasks/management?state=completed&limit=1' })
    expect(donePage.statusCode).toBe(200)
    expect(donePage.json()).toMatchObject({ limit: 1, offset: 0 })
    expect((await app.inject({ url: '/api/tasks/management?limit=0' })).statusCode).toBe(400)
  })
  it('忽略不进入日志或待办，重启和同步不能覆盖选择；恢复与并发人工操作受事务保护', async () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-10-07') }, { end: valueDate('2026-10-12') })
    batch.instance = 'https://ignored-' + randomUUID() + '.example'
    await store.management.apply(batch, defaultZentaoManagement)
    const first = (await store.tasks()).find((task) => task.management?.instance === batch.instance)!
    const ignored = await app.inject({ method: 'PATCH', url: '/api/tasks/' + first.id, payload: { action: 'ignore' } })
    expect(ignored.statusCode).toBe(200)
    expect(ignored.json()).toMatchObject({ completedAt: null, management: { handlingState: 'ignored' } })
    await new Store(pool).management.apply(batch, defaultZentaoManagement)
    expect((await store.snapshotTasks('2026-10-06')).some((task) => task.id === first.id)).toBe(false)
    expect((await store.reportRecords('2026-10-06')).some((task) => task.id === first.id)).toBe(false)
    expect((await store.periodTasks('2026-10-01', '2026-10-31')).some((task) => task.id === first.id)).toBe(false)
    expect((await store.management.page({ state: 'ignored' }, { instance: batch.instance, account: batch.account })).total).toBe(1)
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/' + first.id, payload: { action: 'restore' } })).json().management.handlingState).toBe('pending')
    await Promise.all([store.management.apply(batch, defaultZentaoManagement), store.management.setAction(first.id, 'complete')])
    const saved = (await store.tasks()).find((task) => task.id === first.id)!
    expect(saved.management?.handlingState).toBe('completed')
    expect(saved.completedAt).not.toBeNull()
    expect(saved.title).toContain('已处理')
    expect((await store.reportRecords(dateKey(new Date(saved.completedAt!)))).some((task) => task.id === saved.id)).toBe(true)
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/' + first.id, payload: { completed: true, action: 'ignore' } })).statusCode).toBe(400)
    const manual = await store.createTask('兼容原有个人待办')
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/' + manual.id, payload: { action: 'ignore' } })).statusCode).toBe(409)
  })
  it('停用补充用例待办并收起旧记录，人工状态不变且后续同步不再生成', async () => {
    const batch = managementBatch(undefined, {}, { begin: valueDate('2026-10-01') })
    batch.instance = 'https://coverage-disabled-' + randomUUID() + '.example'
    batch.scopes[0].cases = []
    const task = await store.createTask('旧补充用例提醒')
    await pool.query('UPDATE workbench.tasks SET management=$2 WHERE id=$1', [task.id, JSON.stringify({
      instance: batch.instance, account: batch.account, ruleId: 'coverage', key: 'coverage:101',
      executionId: batch.scopes[0].execution.id, scopeIds: [batch.scopes[0].execution.id],
      riskState: 'active', handlingState: 'ignored', entities: [batch.scopes[0].stories[0]],
    })])
    await pool.query('DELETE FROM workbench.schema_migrations WHERE version=11')
    await migrate(pool)
    const saved = (await store.tasks()).find((entry) => entry.id === task.id)!
    expect(saved.management).toMatchObject({ riskState: 'resolved', handlingState: 'ignored', resolutionReason: '已停用用例覆盖缺口待办' })
    expect(saved.management?.entities).toHaveLength(1)
    expect(saved.completedAt).toBeNull()
    await store.management.apply(batch, defaultZentaoManagement)
    const page = await store.management.page({ state: 'pending' }, { instance: batch.instance, account: batch.account })
    expect(page.tasks.some((entry) => entry.management?.ruleId === 'coverage')).toBe(false)
    await store.deleteTask(task.id)
  })
  it('修正旧测试单 done 误报，保留人工选择并保留真实未关闭项', async () => {
    const batch = managementBatch(undefined, {}, { status: 'closed', realEnd: valueDate('2026-10-05') })
    batch.instance = 'https://testtask-status-' + randomUUID() + '.example'
    batch.scopes[0].testtasks = [{ type: 'testtask', id: '401', title: '已关闭测试单', owner: '', url: '', status: 'doing', removed: false }]
    await store.management.apply(batch, defaultZentaoManagement)
    const task = (await store.tasks()).find((entry) => entry.management?.instance === batch.instance && entry.management.ruleId === 'close-testtasks')!
    await store.management.setAction(task.id, 'ignore')
    // 模拟旧版本已经把接口 done 保存为仍需关闭的风险。
    await pool.query("UPDATE workbench.tasks SET management=jsonb_set(management,'{entities,0,status}', '\"done\"') WHERE id=$1", [task.id])
    const mixed = await store.createTask('混合状态修正验证')
    await pool.query('UPDATE workbench.tasks SET management=$2 WHERE id=$1', [mixed.id, JSON.stringify({ ...task.management,
      entities: [{ ...batch.scopes[0].testtasks[0], status: 'done' }, { ...batch.scopes[0].testtasks[0], id: '402', status: 'wait' }] })])
    await pool.query('DELETE FROM workbench.schema_migrations WHERE version=10')
    await migrate(pool)
    const resolved = (await store.tasks()).find((entry) => entry.id === task.id)!
    expect(resolved.management).toMatchObject({ riskState: 'resolved', handlingState: 'ignored', entities: [] })
    expect(resolved.completedAt).toBeNull()
    const remaining = (await store.tasks()).find((entry) => entry.id === mixed.id)!
    expect(remaining.management).toMatchObject({ riskState: 'active', entities: [{ id: '402', status: 'wait' }] })
    expect(remaining.management?.reason).toContain('1 张')
    batch.scopes[0].testtasks[0].status = 'done'
    await store.management.apply(batch, defaultZentaoManagement)
    expect((await store.management.overview(batch.instance, batch.account, true)).metrics[0].openTesttasks).toBe(0)
    await store.deleteTask(mixed.id)
  })
  it('数据缺口保留事实和快照，完整同步取得上线节点自动收起并保存日期变化', async () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-10-05') }, { end: valueDate('2026-10-12') })
    batch.instance = 'https://partial-' + randomUUID() + '.example'
    await store.management.apply(batch, defaultZentaoManagement)
    const first = (await store.tasks()).find((task) => task.management?.instance === batch.instance)!
    const partial = structuredClone(batch)
    partial.scopes[0].stories[0].actualReleaseAt = { state: 'unavailable', value: '' }
    partial.scopes[0].readable.cases = false; partial.scopes[0].cases = []; partial.scopes[0].issues = ['用例读取失败']
    await store.management.apply(partial, defaultZentaoManagement)
    expect((await store.tasks()).find((task) => task.id === first.id)?.management).toMatchObject({ riskState: 'active', stale: true })
    const overview = await store.management.overview(batch.instance, batch.account)
    expect(overview.metrics[0]).toMatchObject({ health: 'red', incomplete: true, overdue: 1, covered: 1 })
    expect(overview.history).toHaveLength(1)
    batch.collectedAt = '2026-10-07T04:00:00Z'; batch.scopes[0].collectedAt = batch.collectedAt
    batch.scopes[0].stories[0].actualReleaseAt = valueDate('2026-10-06')
    await store.management.apply(batch, defaultZentaoManagement)
    const resolved = (await store.tasks()).find((task) => task.id === first.id)!
    expect(resolved).toMatchObject({ completedAt: null, management: { handlingState: 'pending', riskState: 'resolved', resolutionReason: '已取得上线节点', stale: false } })
    expect(resolved.management?.history?.length).toBeGreaterThan(0)
    const savedScope = (await pool.query('SELECT data FROM workbench.zentao_management_scopes WHERE instance=$1 AND account=$2', [batch.instance, batch.account])).rows[0].data.scope
    expect(savedScope.stories[0].releaseDates).toMatchObject({ planned: { source: 'story', fieldPath: '计划上线时间' }, actual: { source: 'story' }, fallbackExecutionId: '10' })
    expect(savedScope.stories[0].dateHistory.length).toBeGreaterThan(0)
    expect((await store.snapshotTasks('2026-10-07')).some((task) => task.id === first.id)).toBe(false)
    expect((await store.management.overview(batch.instance, batch.account)).metrics[0]).toMatchObject({ released: 1, datedReleased: 1, onTimeReleased: 0 })
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/' + first.id, payload: { action: 'restore' } })).statusCode).toBe(409)
    await store.management.markFailed(batch.instance, batch.account, '本次同步无法连接')
    expect((await store.management.overview(batch.instance, batch.account)).lastUpdatedAt).toBe(batch.collectedAt)
  })
  it('评审首次观察时间持久化，版本变化重新计时；汇总对象增加不重新打开忽略事项', async () => {
    const batch = managementBatch('2026-10-01T04:00:00Z', { plannedReleaseAt: valueDate('2026-11-01') }, { end: valueDate('2026-11-01') })
    batch.instance = 'https://review-' + randomUUID() + '.example'
    batch.scopes[0].cases = [managementCase({ status: 'wait' })]
    await store.management.apply(batch, defaultZentaoManagement)
    batch.collectedAt = '2026-10-04T04:00:00Z'
    await new Store(pool).management.apply(batch, defaultZentaoManagement)
    let own = (await store.tasks()).filter((task) => task.management?.instance === batch.instance)
    expect(own.find((task) => task.management?.ruleId === 'review')?.management?.occurrence).toBe(1)
    batch.scopes[0].cases[0].version = '2'
    await store.management.apply(batch, defaultZentaoManagement)
    own = (await store.tasks()).filter((task) => task.management?.instance === batch.instance)
    expect(own.find((task) => task.management?.ruleId === 'review')?.management?.riskState).toBe('resolved')
    batch.collectedAt = '2026-10-07T04:00:00Z'; batch.scopes[0].execution.status = 'closed'
    await store.management.apply(batch, defaultZentaoManagement)
    own = (await store.tasks()).filter((task) => task.management?.instance === batch.instance)
    const closure = own.find((task) => task.management?.ruleId === 'close-stories')!
    await store.management.setAction(closure.id, 'ignore')
    batch.scopes[0].stories.push({ ...batch.scopes[0].stories[0], id: '102' })
    batch.associations['102'] = ['10']
    await store.management.apply(batch, defaultZentaoManagement)
    own = (await store.tasks()).filter((task) => task.management?.instance === batch.instance)
    expect(own.filter((task) => task.management?.ruleId === 'close-stories')).toHaveLength(1)
    expect(own.find((task) => task.id === closure.id)?.management).toMatchObject({ handlingState: 'ignored', entities: expect.arrayContaining([expect.objectContaining({ id: '102' })]) })
  })
  it('已完成管理事项恢复或忽略后，清理对应日报摘要与工作成果标记', async () => {
    const batch = managementBatch()
    batch.instance = 'https://report-state-' + randomUUID() + '.example'
    await store.management.apply(batch, defaultZentaoManagement)
    const task = (await store.management.page({}, { instance: batch.instance, account: batch.account })).tasks[0]
    await store.management.setAction(task.id, 'complete')
    const report = { day: '2050-01-01', generatedAt: new Date().toISOString(), revision: 1, recordCount: 1,
      recordVersions: { [task.id]: '隔离记录版本' }, items: [{ topic: '测试管理跟进', text: '已处理管理关注事项', taskIds: [task.id], localTemplate: 'zentao-management' }] }
    await pool.query('INSERT INTO workbench.daily_reports(day,data,revision) VALUES($1,$2,1)', [report.day, JSON.stringify(report)])
    await store.management.setAction(task.id, 'restore')
    expect(await store.dailyReport(report.day)).toMatchObject({ items: [], recordVersions: {}, recordCount: 0, revision: 2 })
    expect(await store.saveDailyReport({ ...report, day: '2050-01-02' }, 0)).toBeNull()
  })
  it('完整同步确认需求移除或冲刺取消后，收起相应上线和用例事项', async () => {
    const batch = managementBatch()
    batch.instance = 'https://removed-' + randomUUID() + '.example'
    batch.scopes[0].cases = [managementCase({ status: 'wait', reviewSubmittedAt: '2026-10-01T04:00:00Z' })]
    await store.management.apply(batch, defaultZentaoManagement)
    const ids = (await store.tasks()).filter((task) => task.management?.instance === batch.instance).map((task) => task.id)
    expect(ids).toHaveLength(2)
    batch.scopes[0].stories = []; batch.scopes[0].cases = []; batch.associations = {}
    await store.management.apply(batch, defaultZentaoManagement)
    expect((await store.tasks()).filter((task) => ids.includes(task.id)).every((task) => task.management?.riskState === 'resolved')).toBe(true)
    const cancelled = managementBatch()
    cancelled.instance = batch.instance
    await store.management.apply(cancelled, defaultZentaoManagement)
    cancelled.scopes[0].execution.removed = true; cancelled.scopes[0].execution.status = 'cancel'
    await store.management.apply(cancelled, defaultZentaoManagement)
    expect((await store.management.page({}, { instance: batch.instance, account: batch.account })).total).toBe(0)
    expect((await store.management.overview(batch.instance, batch.account)).metrics).toHaveLength(0)
  })
  it('每个冲刺独立提交，单个冲刺数据库保存失败不会回滚其他冲刺', async () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-10-07') }, { end: valueDate('2026-10-12') })
    batch.instance = 'https://isolated-' + randomUUID() + '.example'
    const second = structuredClone(batch.scopes[0])
    second.execution.id = '11'; second.stories[0].id = '102'; second.cases[0].storyId = '102'
    batch.scopes.push(second); batch.executions.push(second.execution); batch.associations['102'] = ['11']
    // 故障注入只作用于本次隔离库和唯一测试实例。
    await pool.query(`CREATE FUNCTION workbench.management_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.instance='${batch.instance}' AND NEW.execution_id='10' THEN RAISE EXCEPTION '隔离测试故障'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER management_test_failure BEFORE INSERT ON workbench.zentao_management_scopes FOR EACH ROW EXECUTE FUNCTION workbench.management_test_failure()')
    try {
      const result = await store.management.apply(batch, defaultZentaoManagement)
      expect(result.issues).toContain('冲刺 10 保存失败，保留上次判断')
      expect(result.created).toBe(1)
      expect((await store.management.overview(batch.instance, batch.account)).metrics.map((entry) => entry.executionId)).toEqual(['11'])
      expect((await store.management.page({}, { instance: batch.instance, account: batch.account })).tasks[0].management?.executionId).toBe('11')
    } finally {
      await pool.query('DROP TRIGGER management_test_failure ON workbench.zentao_management_scopes')
      await pool.query('DROP FUNCTION workbench.management_test_failure()')
    }
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
