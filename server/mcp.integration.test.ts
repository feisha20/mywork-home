import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { McpClientView, McpToolName } from '../shared/mcp.js'
import { loadConfig } from './config.js'
import { migrate } from './migrations.js'
import { Store } from './store.js'
import { createApp } from './app.js'
import { DailyReportService } from './dailyReport.js'
import { PeriodicReportService } from './periodicReport.js'
import { McpAuth } from './mcpAuth.js'
import { McpService } from './mcpService.js'
import type { SyncService } from './sync.js'
import { ScheduledTasks } from './scheduledTasks.js'
import { managementBatch } from './zentaoManagement.fixtures.js'
import { defaultZentaoManagement } from '../shared/zentaoManagement.js'
import { reportRecordVersion } from '../shared/dailyReports.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const enabled = process.env.RUN_DATABASE_TESTS === 'true'
const prefix = `mcp-fixture-${randomUUID().slice(0, 8)}`, day = '2099-10-07', month = '2099-10', instance = `https://${prefix}.example.test`
let pool: Pool, store: Store, auth: McpAuth, service: McpService, app: FastifyInstance, reports: DailyReportService, directory: string
let reader: { client: McpClientView; token: string }, writer: { client: McpClientView; token: string }
const generate = vi.fn(async () => { throw new Error('MCP 不应调用模型') })
const ids: string[] = [], planIds: string[] = []
let work: string, personal: string, second: string, stale: string
async function fixture(input: { source?: string; title: string; personal?: boolean; project?: string; evidence?: unknown[]; stale?: boolean; completed?: boolean; recordedDay?: string }) {
  const id = randomUUID(); ids.push(id)
  await pool.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,recorded_at,completed_at,project_path,evidence,is_personal,evidence_stale)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, prefix, input.source ?? 'codex', input.title,
    `${input.recordedDay ?? day}T01:00:00Z`, input.source === 'manual' ? null : `${input.recordedDay ?? day}T02:00:00Z`,
    input.completed ? `${input.recordedDay ?? day}T03:00:00Z` : null, input.project ?? `/${prefix}/同名项目`, JSON.stringify(input.evidence ?? []), !!input.personal, !!input.stale])
  return id
}
async function invoke(name: McpToolName, args: unknown, client = writer.client) {
  const response = await service.invoke(name, args, client)
  return response.data as any
}
async function rpc(method: string, params: unknown = {}, token = writer.token, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/mcp', headers: { host: '127.0.0.1:8787', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers },
    payload: { jsonrpc: '2.0', id: 1, method, params } })
}

describe.skipIf(!enabled).sequential('MCP 隔离数据库与标准协议', () => {
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.includes('_test')) throw new Error('MCP 集成测试必须使用专用测试数据库')
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 })
    await migrate(pool); await migrate(pool)
    store = new Store(pool); auth = new McpAuth(pool)
    directory = await mkdtemp(join(tmpdir(), 'mcp-fixture-'))
    const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, WORKBENCH_RUNTIME_DIR: directory, STATIC_DIR: join(directory, 'no-static'), SYNC_ENABLED: 'false', WORKBENCH_LLM_API_KEY: 'fixture-model-secret' })
    const sync = { settings: { zentaoConnection: () => ({ baseUrl: instance, account: 'fixture', password: 'fixture-secret' }),
      runtimeConfig: () => ({ ...config, sourceSecrets: ['fixture-secret'] }), channels: () => [{ id: 'zentao', enabled: true }], zentaoManagementSettings: () => defaultZentaoManagement },
      snapshot: async () => ({ harness: { run: { id: 'fixture-run', status: 'partial_failed', phase: 'idle', startedAt: '2099-10-07T01:00:00Z', finishedAt: '2099-10-07T02:00:00Z', errors: ['密码=fixture-secret，权限不足'] } },
        dataVersion: 'fixture-version', sources: { codex: { available: false, error: '采集目录缺失' } } }) } as unknown as SyncService
    service = new McpService(store, sync, config)
    reports = new DailyReportService(store, { generateDailyReport: generate, close: async () => {} })
    app = await createApp(config, store, sync, reports)
    reader = await auth.issue({ name: `${prefix}-reader`, canWrite: false, canReadEvidence: false })
    writer = await auth.issue({ name: `${prefix}-writer`, canWrite: true, canReadEvidence: true })
    await auth.setEnabled(true)
    work = await fixture({ title: `${prefix} 登录修复`, completed: true, evidence: [{ source: 'codex', timestamp: `${day}T01:00:00Z`, messageId: 'fixture-message', sessionId: 'fixture-session', projectPath: '/fixture', quote: 'password=fixture-secret ' + '中'.repeat(2100), valid: true }] })
    personal = await fixture({ title: `${prefix} 私人旅行安排`, personal: true, evidence: [{ quote: '私人会话内容', valid: true }] })
    second = await fixture({ source: 'claude', title: `${prefix} 登录复验`, project: `/another/${prefix}/同名项目` })
    stale = await fixture({ title: `${prefix} 已撤回来源`, recordedDay: '2099-10-06', completed: true, stale: true, evidence: [{ quote: '已撤回片段', valid: false, invalidReason: 'withdrawn' }] })
    await fixture({ source: 'manual', title: `${prefix} 提醒包含百分号%`, recordedDay: '2099-10-06' })
  })
  afterAll(async () => {
    await app?.close()
    if (pool) {
      await pool.query('DELETE FROM workbench.mcp_audit WHERE client_id IN (SELECT id FROM workbench.mcp_clients WHERE name LIKE $1)', [`${prefix}%`])
      await pool.query('DELETE FROM workbench.mcp_requests WHERE client_id IN (SELECT id FROM workbench.mcp_clients WHERE name LIKE $1)', [`${prefix}%`])
      await pool.query('DELETE FROM workbench.mcp_clients WHERE name LIKE $1', [`${prefix}%`])
      await pool.query('UPDATE workbench.mcp_config SET enabled=false')
      await pool.query('DELETE FROM workbench.zentao_risk_registry WHERE instance=$1', [instance])
      await pool.query('DELETE FROM workbench.tasks WHERE id=ANY($1::text[]) OR management->>\'instance\'=$2', [ids, instance])
      await pool.query('DELETE FROM workbench.scheduled_tasks WHERE id=ANY($1::text[])', [planIds])
      for (const table of ['zentao_management_scopes', 'zentao_management_daily', 'zentao_management_status']) await pool.query(`DELETE FROM workbench.${table} WHERE instance=$1`, [instance])
      await pool.query('DELETE FROM workbench.daily_reports WHERE day=ANY($1::date[])', [[day, '2099-10-08']])
      await pool.query('DELETE FROM workbench.periodic_reports WHERE type=\'monthly\' AND period_key=$1', [month])
      await pool.end()
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  it('按日期、来源、关键词和项目查询，分页汇总一致，同名项目不自动合并', async () => {
    const result = await invoke('search_work_items', { query: prefix, startDate: '2099-10-06', endDate: day, limit: 1 })
    expect(result.total).toBe(4); expect(result.items).toHaveLength(1)
    const all = await invoke('search_work_items', { query: prefix, limit: 100 })
    expect(all.items.some((item: any) => item.id === personal)).toBe(false)
    expect(all.items.find((item: any) => item.id === second).status).toBe('recorded')
    const project = (await invoke('get_work_item', { id: work })).item.projectKey
    const scoped = await invoke('search_work_items', { projectKey: project, source: 'codex', startDate: day, endDate: day })
    expect(scoped.items.map((item: any) => item.id)).toEqual([work])
    const literal = await invoke('search_work_items', { query: '%' }); expect(literal.items.every((item: any) => item.title.includes('%'))).toBe(true)
    const projects = await invoke('list_projects', { limit: 100 })
    const keys = projects.items.filter((project: any) => project.name === '同名项目').map((project: any) => project.key)
    expect(new Set(keys).size).toBeGreaterThanOrEqual(2)
    const overview = await invoke('get_work_overview', { startDate: day, endDate: day })
    expect(overview.records).toBe(2); expect(overview.completed).toBe(1)
  })
  it('个人事项不能通过直接ID、证据、检索或报告素材访问', async () => {
    await expect(invoke('get_work_item', { id: personal })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(invoke('get_work_evidence', { id: personal })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const material = await invoke('get_report_material', { type: 'daily', key: day })
    expect(JSON.stringify(material)).not.toContain(personal); expect(JSON.stringify(material)).not.toContain('私人旅行')
    await expect(invoke('get_work_item', { id: personal, includePersonal: true })).rejects.toThrow()
  })
  it('来源证据再次脱敏，截断有标记，撤回证据保留失效信息', async () => {
    const evidence = await invoke('get_work_evidence', { id: work })
    expect(evidence.limit).toBe(5); expect([...evidence.items[0].quote]).toHaveLength(2000)
    expect(evidence.items[0].truncated).toBe(true); expect(JSON.stringify(evidence)).not.toContain('fixture-secret')
    const withdrawn = await invoke('get_work_evidence', { id: stale })
    expect(withdrawn).toMatchObject({ evidenceStale: true, items: [{ valid: false, invalidReason: 'withdrawn' }] })
    expect((await invoke('get_work_item', { id: stale })).item).toMatchObject({ status: 'needs_review', completionConfirmed: false })
    expect((await invoke('search_work_items', { query: prefix, status: 'completed' })).items.some((item: any) => item.id === stale)).toBe(false)
    await expect(invoke('get_work_evidence', { id: work }, reader.client)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('只读令牌禁止写入，创建请求幂等且不同内容不能复用标识', async () => {
    const input = { title: `${prefix} 进一步复核`, requestId: randomUUID() }
    await expect(invoke('create_todo', input, reader.client)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const [a, b] = await Promise.all([invoke('create_todo', input), invoke('create_todo', input)])
    ids.push(a.item.id)
    expect(a.item.id).toBe(b.item.id); expect([a.reused, b.reused].sort()).toEqual([false, true])
    await expect(invoke('create_todo', { ...input, title: '不同内容' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('事项更新版本检查和业务限制都在同一事务执行', async () => {
    const id = await fixture({ source: 'manual', title: `${prefix} 本地待办` })
    const original = (await invoke('get_work_item', { id })).item
    const updated = await invoke('update_todo', { id, version: original.version, title: `${prefix} 更新标题`, isPinned: true })
    expect(updated.item).toMatchObject({ title: `${prefix} 更新标题`, isPinned: true })
    await expect(invoke('update_todo', { id, version: original.version, completed: true })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(invoke('update_todo', { id, version: updated.item.version, title: '不能部分提交', completed: true, isPinned: false })).rejects.toThrow('未完成待办')
    expect((await invoke('get_work_item', { id })).item.title).toBe(`${prefix} 更新标题`)
    const log = (await invoke('get_work_item', { id: work })).item
    await expect(invoke('update_todo', { id: work, version: log.version, completed: true })).rejects.toMatchObject({ code: 'READ_ONLY_ITEM' })
    const bug = await fixture({ source: 'zentao', title: `${prefix} 禅道 Bug` })
    await pool.query("UPDATE workbench.tasks SET reference='BUG-1' WHERE id=$1", [bug])
    const bugItem = (await invoke('get_work_item', { id: bug })).item
    await expect(invoke('update_todo', { id: bug, version: bugItem.version, isPinned: true })).rejects.toMatchObject({ code: 'READ_ONLY_ITEM' })
  })
  it('协议初始化、工具发现和中文Prompts符合SDK协议，权限决定工具目录', async () => {
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
    expect(initialized.statusCode).toBe(200); expect(initialized.json().result.serverInfo.name).toBe('mywork-home')
    expect(initialized.headers['cache-control']).toBe('no-store')
    const full = await rpc('tools/list'); expect(full.json().result.tools).toHaveLength(14)
    const limited = await rpc('tools/list', {}, reader.token)
    expect(limited.json().result.tools).toHaveLength(10)
    const prompts = await rpc('prompts/list'); expect(prompts.json().result.prompts).toHaveLength(4)
    const prompt = await rpc('prompts/get', { name: 'write_report', arguments: { request: '本周周报' } })
    expect(prompt.json().result.messages[0].content.text).toContain('本周周报')
    const call = await rpc('tools/call', { name: 'get_work_item', arguments: { id: work } })
    expect(call.json().result.structuredContent.data.item.id).toBe(work)
    const denied = await rpc('tools/call', { name: 'create_todo', arguments: { title: '越权', requestId: randomUUID() } }, reader.token)
    expect(denied.json().result.isError).toBe(true)
    expect((await pool.query('SELECT count(*)::int AS count FROM workbench.tasks WHERE title=$1', ['越权'])).rows[0].count).toBe(0)
    const invalid = await rpc('tools/call', { name: 'search_work_items', arguments: { limit: 101 } })
    expect(invalid.json().result.isError).toBe(true)
  })
  it('入口拒绝无令牌和外部来源，令牌撤销及服务停用立即生效', async () => {
    expect((await rpc('tools/list', {}, 'bad-token')).statusCode).toBe(401)
    expect((await rpc('tools/list', {}, writer.token, { origin: 'http://attacker.example' })).statusCode).toBe(403)
    expect((await rpc('tools/list', {}, writer.token, { host: 'attacker.example' })).statusCode).toBe(403)
    const external = { host: 'attacker.example', origin: 'http://attacker.example' }
    expect((await app.inject({ url: '/api/%6dcp/settings', headers: external })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/%6dcp/clients', headers: external,
      payload: { name: `${prefix}-encoded`, canWrite: true, canReadEvidence: true } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/%6dcp', headers: { ...external, authorization: `Bearer ${writer.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } })).statusCode).toBe(403)
    const issued = await auth.issue({ name: `${prefix}-revoked`, canWrite: false, canReadEvidence: false })
    await auth.revoke(issued.client.id)
    expect((await rpc('tools/list', {}, issued.token)).statusCode).toBe(401)
    await auth.setEnabled(false); expect((await rpc('tools/list')).statusCode).toBe(401); await auth.setEnabled(true)
    const stored = await pool.query('SELECT token_hash FROM workbench.mcp_clients WHERE id=$1', [writer.client.id])
    expect(stored.rows[0].token_hash).not.toContain(writer.token)
  })
  it('官方 MCP 客户端通过真实本机 HTTP 完成握手、发现与读取，不连接模型', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: '隔离验收客户端', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${writer.token}` } } }))
      expect((await client.listTools()).tools).toHaveLength(14)
      expect((await client.listPrompts()).prompts).toHaveLength(4)
      const result = await client.callTool({ name: 'get_work_item', arguments: { id: work } })
      expect(result.structuredContent).toMatchObject({ data: { item: { id: work } }, timezone: 'Asia/Shanghai' })
      expect(generate).not.toHaveBeenCalled()
    } finally { await client.close() }
  })
  it('管理接口只返回令牌摘要信息，配置地址支持本机开发代理', async () => {
    const issued = await app.inject({ method: 'POST', url: '/api/mcp/clients', payload: { name: `${prefix}-admin`, canWrite: false, canReadEvidence: false } })
    expect(issued.statusCode).toBe(201)
    const settings = await app.inject({ url: '/api/mcp/settings', headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' } })
    expect(settings.statusCode).toBe(200); expect(settings.json().endpoint).toBe('http://127.0.0.1:8787/mcp')
    expect(settings.body).not.toContain(issued.json().token); expect(settings.body).not.toContain('token_hash')
    const revoke = await app.inject({ method: 'DELETE', url: `/api/mcp/clients/${issued.json().client.id}`, payload: {} })
    expect(revoke.statusCode).toBe(200)
    expect((await rpc('tools/list', {}, issued.json().token)).statusCode).toBe(401)
  })
  it('采集错误保留资料缺口并脱敏，计划列表排除个人事项', async () => {
    const status = await invoke('get_source_status', {})
    expect(status.lastSync.status).toBe('partial_failed'); expect(status.sources.codex.available).toBe(false)
    expect(JSON.stringify(status)).not.toContain('fixture-secret')
    const scheduler = new ScheduledTasks(store)
    const input = { title: `${prefix} 周期工作`, frequency: 'daily' as const, time: '09:00', weekday: 5, day: 1, month: 1, quarterMonth: 1, startDate: day, endDate: null, enabled: true, isPersonal: false }
    const a = (await scheduler.save(input))!, b = (await scheduler.save({ ...input, title: '私人计划', isPersonal: true }))!
    planIds.push(a.id, b.id)
    const plans = await invoke('list_scheduled_tasks', { limit: 100 })
    expect(plans.items.some((plan: any) => plan.id === a.id)).toBe(true)
    expect(plans.items.some((plan: any) => plan.id === b.id)).toBe(false)
  })
  it('日报保存验证覆盖范围、报告版本和素材版本；已编辑日报自动流程不调用模型', async () => {
    const material = await invoke('get_report_material', { type: 'daily', key: day, limit: 100 })
    const input = { type: 'daily', key: day, revision: material.revision, materialVersion: material.materialVersion,
      items: [{ text: '推进登录修复与复验，继续核对剩余问题。', taskIds: [work, second] }] }
    await expect(invoke('save_report', { ...input, items: [{ text: '不能引用私人事项', taskIds: [work, second, personal] }] })).rejects.toThrow('未知工作记录')
    await expect(invoke('save_report', { ...input, items: [{ text: '遗漏工作', taskIds: [work] }] })).rejects.toThrow('遗漏')
    const saved = await invoke('save_report', input)
    expect(saved.report).toMatchObject({ edited: true, revision: material.revision + 1 })
    expect((await app.inject({ url: `/api/daily-reports/${day}` })).json().items[0].text).toBe(input.items[0].text)
    await expect(invoke('save_report', input)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await reports.generateQueued(day)).items[0].text).toBe(input.items[0].text); expect(generate).not.toHaveBeenCalled()
    const next = await invoke('get_report_material', { type: 'daily', key: day })
    const extra = await fixture({ title: `${prefix} 新增日志` })
    await expect(invoke('get_report_material', { type: 'daily', key: day, offset: 1, materialVersion: next.materialVersion })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(invoke('save_report', { ...input, revision: next.revision, materialVersion: next.materialVersion })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await invoke('get_report', { type: 'daily', key: day })).needsRefresh).toBe(true)
    await reports.generateQueued(day); expect(generate).not.toHaveBeenCalled()
    await pool.query('UPDATE workbench.tasks SET deleted_at=now() WHERE id=$1', [extra])
  })
  it('周月报读取保持纯读取，助手保存正文保留，个人分类变更后不输出待复核正文', async () => {
    const material = await invoke('get_report_material', { type: 'monthly', key: month })
    const saved = await invoke('save_report', { type: 'monthly', key: month, revision: material.revision, materialVersion: material.materialVersion, markdown: '# 工作月报\n\n推进登录质量改进。' })
    expect(saved.report.edited).toBe(true)
    const automatic = await new PeriodicReportService(store).generate('monthly', month, saved.report.revision, true)
    expect(automatic.markdown).toBe(saved.report.markdown)
    const extra = await fixture({ title: `${prefix} 报告保存后的新工作` })
    expect(await invoke('get_report', { type: 'monthly', key: month })).toMatchObject({ report: null, needsRefresh: true })
    await pool.query('UPDATE workbench.tasks SET deleted_at=now() WHERE id=$1', [extra])
    await store.setPersonal(second, true)
    const before = await pool.query('SELECT data,revision,updated_at FROM workbench.periodic_reports WHERE type=\'monthly\' AND period_key=$1', [month])
    const report = await invoke('get_report', { type: 'monthly', key: month })
    expect(report).toMatchObject({ report: null, needsRefresh: true, exists: true })
    const after = await pool.query('SELECT data,revision,updated_at FROM workbench.periodic_reports WHERE type=\'monthly\' AND period_key=$1', [month])
    expect(after.rows).toEqual(before.rows)
    expect(JSON.stringify(await invoke('get_report_material', { type: 'monthly', key: month, limit: 100 }))).not.toContain(second)
    await store.setPersonal(second, false)
  })
  it('管理数据限制在当前身份，风险只读，指标不可读状态保留', async () => {
    const batch = managementBatch()
    batch.instance = instance; batch.account = 'fixture'
    batch.scopes[0].readable.bugs = false
    await store.management.apply(batch, defaultZentaoManagement)
    const overview = await invoke('get_management_overview', { limit: 1 })
    expect(overview.metrics.items[0].incomplete).toBe(true)
    expect(overview.metrics.items[0].unknownMetrics).toContain('bugs')
    const risk = await pool.query('SELECT id FROM workbench.tasks WHERE management->>\'instance\'=$1 LIMIT 1', [instance])
    if (risk.rows[0]) {
      const item = (await invoke('get_work_item', { id: risk.rows[0].id })).item
      await expect(invoke('update_todo', { id: item.id, version: item.version, completed: true })).rejects.toMatchObject({ code: 'READ_ONLY_ITEM' })
      await pool.query('UPDATE workbench.tasks SET is_personal=true WHERE id=$1', [item.id])
      expect(JSON.stringify(await invoke('list_management_risks', {}))).not.toContain(item.id)
    }
  })
  it('调用审计不保存证据正文、令牌和报告内容', async () => {
    await rpc('tools/call', { name: 'get_work_evidence', arguments: { id: work } })
    const audit = await pool.query('SELECT * FROM workbench.mcp_audit WHERE client_id=$1 ORDER BY id', [writer.client.id])
    expect(audit.rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(audit.rows)
    expect(text).not.toContain(writer.token); expect(text).not.toContain('fixture-secret'); expect(text).not.toContain('中中中')
    expect(audit.rows.some((row) => row.tool === 'get_work_evidence' && row.object_id === work)).toBe(true)
  })
  it('没有有效证据的旧自动完成状态需要复核，重新打开的手工事项不继续输出已完成日报条目', async () => {
    const legacy = await fixture({ title: `${prefix} 无证据的历史自动状态`, recordedDay: '2099-10-05', completed: true })
    expect((await invoke('get_work_item', { id: legacy })).item).toMatchObject({ completionConfirmed: false, status: 'needs_review' })
    const reopenDay = '2099-10-08', manual = await fixture({ source: 'manual', title: `${prefix} 人工事项`, recordedDay: reopenDay, completed: true })
    const record = (await store.reportRecords(reopenDay)).find((task) => task.id === manual)!
    const saved = await store.saveDailyReport({ day: reopenDay, generatedAt: new Date().toISOString(), recordCount: 1, revision: 1, edited: true,
      items: [{ text: '完成手工事项', taskIds: [manual] }], recordVersions: { [manual]: reportRecordVersion(record) } }, 0)
    expect(saved).not.toBeNull()
    expect(JSON.stringify((await invoke('get_report', { type: 'daily', key: reopenDay })).report)).toContain('完成手工事项')
    const original = (await invoke('get_work_item', { id: manual })).item
    await invoke('update_todo', { id: manual, version: original.version, completed: false })
    const read = await invoke('get_report', { type: 'daily', key: reopenDay })
    expect(read).toMatchObject({ report: { items: [] }, needsRefresh: true })
  })
})
