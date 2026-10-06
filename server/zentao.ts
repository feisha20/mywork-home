import type { ZentaoConnection } from '../shared/settings.js'
import type { Task } from '../src/domain/workbench.js'
import { digest } from './records.js'
import { redact } from './redact.js'

type JsonObject = Record<string, unknown>
type WorkType = 'bug' | 'task'
export interface ZentaoTrackedItem { type: WorkType; id: string }
export interface ZentaoWorkItem {
  id: string; reference: string; title: string; createdAt: string; completedAt: string | null
  state: 'pending' | 'completed' | 'removed'
  zentao: NonNullable<Task['zentao']>
}
export interface ZentaoSnapshot {
  instance: string; account: string; items: ZentaoWorkItem[]; bugs: number; tasks: number
}
export class ZentaoError extends Error {}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const code = (value: unknown) => typeof value === 'string' ? value : object(value) && typeof value.code === 'string' ? value.code : ''
const accountOf = (value: unknown) => typeof value === 'string' ? value : object(value) && typeof value.account === 'string' ? value.account : ''
const integer = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null

export function zentaoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.startsWith('0000-') || value.startsWith('1970-')) return null
  const local = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(value)
  const input = local ? `${value.replace(' ', 'T')}${value.length === 10 ? 'T00:00:00' : ''}+08:00` : value
  if (!local && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(input)) return null
  const date = new Date(input)
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1970 ? date.toISOString() : null
}

function workItem(row: unknown, type: WorkType, connection: ZentaoConnection, token: string): ZentaoWorkItem {
  if (!object(row)) throw new ZentaoError('禅道工作列表格式不兼容，请检查 V2 接口')
  const remoteId = integer(row.id), status = code(row.status), title = type === 'bug' ? row.title : row.name
  const statuses = type === 'bug' ? ['active', 'resolved', 'closed'] : ['wait', 'doing', 'pause', 'done', 'closed', 'cancel']
  if (!remoteId || typeof title !== 'string' || !title.trim() || !statuses.includes(status)) throw new ZentaoError('禅道事项缺少有效编号、标题或状态，本轮保留已有待办')
  const instance = connection.baseUrl.replace(/\/+$/, '')
  // 已解决但仍指派给本人时还需要验证；本人解决并转交验证后才记录解决时间。
  const assignedToMe = accountOf(row.assignedTo) === connection.account
  const isDone = type === 'bug'
    ? status === 'closed' || status === 'resolved' && !assignedToMe && accountOf(row.resolvedBy) === connection.account
    : ['done', 'closed'].includes(status)
  const removed = [true, 1, '1'].includes(row.deleted as string | number | boolean) || status === 'cancel' || (!isDone && !assignedToMe)
  const pending = !isDone && (type === 'bug' ? ['active', 'resolved'].includes(status) : ['wait', 'doing', 'pause'].includes(status))
  const text = (value: unknown) => typeof value === 'string' ? redact(value, [connection.password, token]).trim() : ''
  const deadline = text(row.deadline)
  const completedAt = !isDone ? null : type === 'bug'
    ? zentaoTimestamp(status === 'closed' ? row.closedDate : row.resolvedDate)
    : zentaoTimestamp(row.finishedDate) ?? zentaoTimestamp(row.closedDate)
  return {
    id: `zentao-${digest(`${instance}:${connection.account}:${type}:${remoteId}`)}`,
    reference: `${type === 'bug' ? 'BUG' : 'TASK'}-${remoteId}`,
    title: text(title).slice(0, 300),
    createdAt: zentaoTimestamp(row.openedDate) ?? zentaoTimestamp(row.assignedDate) ?? new Date().toISOString(),
    completedAt,
    state: removed ? 'removed' : pending ? 'pending' : 'completed',
    zentao: { instance, account: connection.account, type, id: String(remoteId), status,
      url: `${instance}/${type}-view-${remoteId}.html`, priority: integer(row.pri),
      project: text(row.projectName) || text(row.executionName) || text(row.productName),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) && !deadline.startsWith('0000-') ? deadline : null },
  }
}

// 所有请求固定使用 V2。读取个人工作列表及已采集事项详情，不向模型发送内容或回写远端。
export class ZentaoV2Client {
  private token = ''
  private signal = AbortSignal.timeout(60_000)
  constructor(private connection: ZentaoConnection) {}
  private async request(path: string, body?: JsonObject): Promise<JsonObject> {
    const url = `${this.connection.baseUrl.replace(/\/+$/, '')}/api.php/v2${path}`
    let response: Response
    try {
      response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { token: this.token } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]) })
    } catch { throw new ZentaoError('禅道连接失败或超时，请检查地址与网络') }
    if (!response.ok) {
      await response.body?.cancel()
      const reasons: Record<number, string> = { 401: '禅道认证失败，请检查账号和密码', 403: '禅道账号没有读取该事项或工作列表的权限', 404: '禅道 V2 接口不存在，请检查禅道地址和版本' }
      throw new ZentaoError(reasons[response.status] ?? '禅道接口请求失败，本轮保留已有待办')
    }
    const result: unknown = await response.json().catch(() => null)
    if (!object(result) || result.status !== 'success') throw new ZentaoError(body ? '禅道登录失败，请检查账号和密码' : '禅道工作列表读取失败，本轮保留已有待办')
    return result
  }
  private async login() {
    const result = await this.request('/users/login', { account: this.connection.account, password: this.connection.password })
    if (typeof result.token !== 'string' || !result.token || result.token.length > 4096
      || object(result.user) && accountOf(result.user) && accountOf(result.user) !== this.connection.account) throw new ZentaoError('禅道 V2 登录响应格式不兼容')
    this.token = result.token
  }
  private async list(type: WorkType): Promise<ZentaoWorkItem[]> {
    const items: ZentaoWorkItem[] = [], seen = new Set<string>()
    const key = type === 'bug' ? 'bugs' : 'tasks'
    let expectedTotal: number | null = null
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(`/my/work/${type}?type=assignedTo&orderBy=id_desc&recPerPage=100&pageID=${page}`)
      if (result.mode !== undefined && result.mode !== type || result.type !== undefined && result.type !== 'assignedTo') throw new ZentaoError('禅道未返回指定的个人工作列表，本轮保留已有待办')
      const entries = result[key]
      if (!Array.isArray(entries) && !object(entries)) throw new ZentaoError('禅道工作列表格式不兼容，本轮保留已有待办')
      const rows = Array.isArray(entries) ? entries : Object.values(entries)
      const pager = result.pager
      if (!object(pager)) throw new ZentaoError('禅道未返回完整分页信息，本轮保留已有待办')
      const total = integer(pager.recTotal), pageId = integer(pager.pageID), perPage = integer(pager.recPerPage)
      if (total === null || total > 10_000 || pageId !== page || !perPage || rows.length > perPage
        || expectedTotal !== null && total !== expectedTotal) throw new ZentaoError('禅道分页信息不完整或采集期间列表已变化，请重新同步')
      expectedTotal = total
      for (const row of rows) {
        const item = workItem(row, type, this.connection, this.token)
        if (seen.has(item.id)) throw new ZentaoError('禅道分页出现重复事项，请重新同步')
        seen.add(item.id); items.push(item)
      }
      if (items.length === total) return items
      if (!rows.length || items.length > total || page * perPage >= total) throw new ZentaoError('禅道工作列表未读取完整，本轮保留已有待办')
    }
    throw new ZentaoError('禅道工作列表超过采集上限，本轮保留已有待办')
  }
  async readWork(tracked: readonly ZentaoTrackedItem[] = []): Promise<ZentaoSnapshot> {
    await this.login()
    // 两类列表全部读取成功后才提交快照，失败或缺页不会清空已有待办。
    const items = [...await this.list('bug'), ...await this.list('task')]
    const seen = new Set(items.map((item) => `${item.zentao.type}:${item.zentao.id}`))
    const trackedKeys = new Set<string>()
    if (tracked.length > 10_000) throw new ZentaoError('禅道已采集事项超过采集上限，本轮保留已有待办')
    // 关闭、完成或转派后可能退出个人列表，必须补查详情，不能根据缺席直接删除待办。
    for (const known of tracked) {
      if (!['bug', 'task'].includes(known.type) || !integer(known.id)) throw new ZentaoError('禅道已采集事项编号无效，本轮保留已有待办')
      const key = `${known.type}:${Number(known.id)}`
      trackedKeys.add(key)
      if (seen.has(key)) continue
      const result = await this.request(`/${known.type === 'bug' ? 'bugs' : 'tasks'}/${Number(known.id)}`)
      const item = workItem(result[known.type], known.type, this.connection, this.token)
      if (item.zentao.id !== String(Number(known.id))) throw new ZentaoError('禅道事项详情编号不匹配，本轮保留已有待办')
      items.push(item); seen.add(key)
    }
    if (items.some((item) => item.state === 'completed' && !item.completedAt && trackedKeys.has(`${item.zentao.type}:${item.zentao.id}`))) {
      throw new ZentaoError('禅道已完成事项缺少真实完成时间，本轮保留已有待办')
    }
    return { instance: this.connection.baseUrl.replace(/\/+$/, ''), account: this.connection.account, items,
      bugs: items.filter((item) => item.zentao.type === 'bug' && item.state === 'pending').length,
      tasks: items.filter((item) => item.zentao.type === 'task' && item.state === 'pending').length }
  }
}
