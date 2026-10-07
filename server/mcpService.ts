import { z } from 'zod'
import { dateKey } from '../src/domain/workbench.js'
import { mcpSchema, mcpTools, type McpClientView, type McpToolName } from '../shared/mcp.js'
import { McpData, mcpItem } from './mcpData.js'
import { McpError } from './mcpAuth.js'
import { redact } from './redact.js'
import type { Config } from './config.js'
import type { Store } from './store.js'
import type { SyncService } from './sync.js'

export function redactMcpValue(value: unknown, secrets: string[], field = ''): unknown {
  // 标识由服务端生成或取自业务主键，不把短哈希项目键误识别成凭证，确保后续查询可引用。
  const identifiers = ['id', 'messageId', 'sessionId', 'projectKey', 'version', 'materialVersion', 'taskId', 'taskIds']
  if (typeof value === 'string') return identifiers.includes(field) || field === 'key' && /^(?:local|zentao|zentao-name):[a-f0-9]{32}$/.test(value) ? value : redact(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redactMcpValue(entry, secrets, field))
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactMcpValue(entry, secrets, key)]))
  }
  return value
}
export class McpService {
  readonly data: McpData
  constructor(private store: Store, private sync: SyncService, private config: Config) {
    this.data = new McpData(store, () => {
      const identity = sync.settings?.zentaoConnection()
      return identity ? { instance: identity.baseUrl.replace(/\/+$/, ''), account: identity.account } : null
    })
  }
  private secrets() {
    const config = this.sync.settings?.runtimeConfig() ?? this.config
    return [config.WORKBENCH_LLM_API_KEY, decodeURIComponent(new URL(config.DATABASE_URL).password), ...config.sourceSecrets].filter(Boolean)
  }
  async invoke(name: McpToolName, raw: unknown, client: McpClientView, token = '') {
    const tool = mcpTools.find((entry) => entry.name === name)!
    if ('write' in tool && tool.write && !client.canWrite) throw new McpError('当前令牌仅允许读取', 403, 'FORBIDDEN')
    if ('evidence' in tool && tool.evidence && !client.canReadEvidence) throw new McpError('当前令牌未授权读取来源证据', 403, 'FORBIDDEN')
    let data: unknown
    switch (name) {
      case 'get_work_overview': {
        const input = mcpSchema(name).parse(raw), start = input.startDate ?? input.endDate ?? dateKey(new Date()), end = input.endDate ?? start
        this.checkRange(start, end); data = await this.data.overview(start, end); break
      }
      case 'search_work_items': {
        const input = mcpSchema(name).parse(raw); this.checkRange(input.startDate, input.endDate)
        data = await this.data.search(input); break
      }
      case 'get_work_item': data = { item: mcpItem(await this.data.item(mcpSchema(name).parse(raw).id)) }; break
      case 'get_work_evidence': {
        const input = mcpSchema(name).parse(raw), evidence = await this.data.evidence(input.id, input)
        const secrets = [...this.secrets(), token].filter(Boolean)
        data = { ...evidence, items: evidence.items.map((entry) => {
          const quote = [...redact(entry.quote ?? '', secrets)]
          return { messageId: entry.messageId, sessionId: entry.sessionId, source: entry.source, projectPath: entry.projectPath,
            timestamp: entry.timestamp, quote: quote.slice(0, 2000).join(''), truncated: quote.length > 2000,
            valid: entry.valid !== false, invalidReason: entry.invalidReason ?? null }
        }) }; break
      }
      case 'list_projects': data = await this.data.projects(mcpSchema(name).parse(raw)); break
      case 'get_report': data = await this.data.report(mcpSchema(name).parse(raw)); break
      case 'get_report_material': { const input = mcpSchema(name).parse(raw); data = await this.data.material(input, input, input.materialVersion); break }
      case 'get_management_overview': {
        const input = mcpSchema(name).parse(raw), identity = this.sync.settings?.zentaoConnection()
        if (!identity) { data = { enabled: false, lastUpdatedAt: null, metrics: [], members: [], history: [], issues: ['尚未配置禅道连接'] }; break }
        const enabled = !!this.sync.settings?.channels().find((channel) => channel.id === 'zentao')?.enabled && !!this.sync.settings?.zentaoManagementSettings().enabled
        const view = await this.store.management.overview(identity.baseUrl.replace(/\/+$/, ''), identity.account, enabled)
        const matches = (entry: { projectId: string; executionId: string }) => (!input.projectId || entry.projectId === input.projectId) && (!input.executionId || entry.executionId === input.executionId)
        const metrics = view.metrics.filter(matches), members = view.members.filter(matches), history = view.history.filter((entry) => matches(entry.metrics))
        const take = <T>(items: T[]) => ({ items: items.slice(input.offset, input.offset + input.limit), total: items.length })
        data = { enabled, lastUpdatedAt: view.lastUpdatedAt, issues: view.issues, metrics: take(metrics), members: take(members), history: take(history),
          offset: input.offset, limit: input.limit, note: '只反映已采集数据；incomplete、unknownMetrics、stale 和 issues 为资料缺口，不能据此认定无风险。' }; break
      }
      case 'list_management_risks': data = await this.data.risks(mcpSchema(name).parse(raw)); break
      case 'list_scheduled_tasks': {
        const input = mcpSchema(name).parse(raw)
        const result = await this.store.pool.query(`SELECT id,data,next_at,created_at FROM workbench.scheduled_tasks WHERE NOT (data->>'isPersonal')::boolean ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`, [input.limit, input.offset])
        const count = await this.store.pool.query("SELECT count(*)::int AS total FROM workbench.scheduled_tasks WHERE NOT (data->>'isPersonal')::boolean")
        data = { items: result.rows.map((row) => ({ ...row.data, id: row.id, nextAt: row.next_at, createdAt: row.created_at })), total: count.rows[0].total, ...input }; break
      }
      case 'get_source_status': {
        mcpSchema(name).parse(raw)
        const snapshot = await this.sync.snapshot(), run = snapshot.harness.run
        data = { sources: snapshot.sources, dataVersion: snapshot.dataVersion, lastSync: run ? { id: run.id, status: run.status, phase: run.phase,
          startedAt: run.startedAt, finishedAt: run.finishedAt, errors: run.errors } : null,
          note: '采集失败、来源停用或缺少目录时资料可能不完整；接入状态不代表所有工作已完成。' }; break
      }
      case 'create_todo': { const input = mcpSchema(name).parse(raw); data = await this.data.create(client, redact(input.title, [...this.secrets(), token]), input.requestId); break }
      case 'update_todo': {
        const input = mcpSchema(name).parse(raw)
        data = await this.data.update({ ...input, ...(input.title !== undefined ? { title: redact(input.title, [...this.secrets(), token]) } : {}) }); break
      }
      case 'save_report': {
        const input = mcpSchema(name).parse(raw), secrets = [...this.secrets(), token]
        data = await this.data.saveReport({ ...input, ...(input.items ? { items: input.items.map((item) => ({ ...item, text: redact(item.text, secrets) })) } : {}),
          ...(input.markdown !== undefined ? { markdown: redact(input.markdown, secrets) } : {}) }); break
      }
    }
    return { data: redactMcpValue(data, [...this.secrets(), token].filter(Boolean)), asOf: new Date().toISOString(), timezone: 'Asia/Shanghai' as const }
  }
  private checkRange(start?: string, end?: string) { if (start && end && start > end) throw new McpError('开始日期不能晚于结束日期') }
}
export function mcpFailure(error: unknown) {
  if (error instanceof McpError) return { code: error.code, message: error.message }
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: '请求参数无效，请核对工具说明和字段范围' }
  return { code: 'SERVICE_ERROR', message: '工作台服务或数据库暂时不可用，请稍后重试' }
}
