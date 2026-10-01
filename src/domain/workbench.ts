export const SOURCES = {
  zentao: { label: '禅道 Zentao', className: 'src-zentao' },
  claude: { label: 'Claude Code', className: 'src-claude' },
  codex: { label: 'Codex', className: 'src-codex' },
  workbuddy: { label: 'WorkBuddy', className: 'src-workbuddy' },
  zcode: { label: 'Zcode', className: 'src-zcode' },
  manual: { label: '手动添加', className: 'src-manual' },
} as const

export type SourceId = keyof typeof SOURCES
export const CAPTURE_SOURCES = ['zentao', 'claude', 'codex', 'workbuddy', 'zcode'] as const

export interface Task {
  id: string
  reference: string
  source: SourceId
  title: string
  createdAt: string
  completedAt: string | null
  recordedAt?: string | null
  projectPath?: string
  statusOrigin?: 'manual' | 'ai'
  evidence?: import('../../shared/contracts.js').Evidence[]
}

export interface WorkbenchState {
  version: 1
  tasks: Task[]
}

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
export function dateKey(date: Date): string {
  return dateKeyFormatter.format(date)
}

export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00+08:00`)
}

export function recentWorkdays(today: Date, count = 4): string[] {
  const cursor = dateFromKey(dateKey(today))
  const days = [dateKey(cursor)]
  while (days.length < count) {
    cursor.setTime(cursor.getTime() - 86_400_000)
    const weekday = new Date(`${dateKey(cursor)}T00:00:00Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6) days.push(dateKey(cursor))
  }
  return days
}

export function recordsForDate(state: WorkbenchState, day: string): Task[] {
  return state.tasks
    .filter((task) => { const time = recordTimestamp(task); return time && dateKey(new Date(time)) === day })
    .sort((a, b) => recordTimestamp(b)!.localeCompare(recordTimestamp(a)!))
}

export function requiresManualCompletion(source: SourceId): boolean {
  return source === 'manual' || source === 'zentao'
}

// 自动工作记录归到来源日期；归档时间与真实完成状态分开保存。
export function recordTimestamp(task: Task): string | null {
  if (requiresManualCompletion(task.source)) return task.completedAt
  return task.recordedAt ?? task.evidence?.reduce<string | null>((latest, entry) => !latest || entry.timestamp > latest ? entry.timestamp : latest, null) ?? task.completedAt ?? task.createdAt
}

export function completeTask(state: WorkbenchState, id: string, now: Date): WorkbenchState {
  const task = state.tasks.find((item) => item.id === id)
  if (!task || task.completedAt || !requiresManualCompletion(task.source)) return state
  return {
    ...state,
    tasks: state.tasks.map((item) => item.id === id ? { ...item, completedAt: now.toISOString() } : item),
  }
}

export function addTask(state: WorkbenchState, title: string, id: string, now: Date): WorkbenchState {
  const text = title.trim()
  if (!text || text.length > 300 || state.tasks.some((task) => task.id === id)) return state
  return {
    ...state,
    tasks: [{
      id,
      reference: `TASK-${id.slice(0, 8).toUpperCase()}`,
      source: 'manual',
      title: text,
      createdAt: now.toISOString(),
      completedAt: null,
    }, ...state.tasks],
  }
}

// 首次打开的示例记录只用于展示页面，不代表已连接外部工具。
export function createDemoState(today: Date): WorkbenchState {
  const days = recentWorkdays(today)
  const at = (day: string, hour: number, minute = 0) => {
    return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`).toISOString()
  }
  const pending: Array<[SourceId, string, string]> = [
    ['zentao', 'BUG-20489', '核心支付通道偶发超时及分布式事务一致性复验'],
    ['claude', 'SESSION-9104', '审核 Claude 自动编写的 28 个核心接口契约测试脚本'],
    ['codex', 'HEAL-710', '确认 UI 自动化测试回归中失败元素选择器的自愈结果'],
    ['workbuddy', 'WF-8392', '压测环境 16 节点压测机弹性扩容与权限签收确认'],
  ]
  const logs: Array<[number, SourceId, string, string, number, number]> = [
    [0, 'claude', 'SESSION-882', '利用 Claude 审查合并请求中的单元测试覆盖率', 10, 45],
    [0, 'zentao', 'TASK-1002', '组织敏捷 Sprint 测试用例基线评审并封版', 9, 30],
    [1, 'zentao', 'BUG-20410', '排查分布式压测网关偶发熔断异常，完成阈值配置修正', 17, 40],
    [1, 'codex', 'AUTO-PATCH', '更新回归自动化测试依赖并修复 4 个陈旧元素定位', 15, 10],
    [2, 'workbuddy', 'SPRINT-PLAN', '完成本迭代 QA 工时划分与测试模块拆解', 10, 0],
    [3, 'zentao', 'RELEASE-V3.4', '全量功能验收通过，完成上线前灰度签名确认', 18, 0],
  ]
  return {
    version: 1,
    tasks: [
      ...pending.map(([source, reference, title], index) => ({
        id: `demo-pending-${index}`, source, reference, title,
        createdAt: at(days[0], 8), completedAt: null,
      })),
      ...logs.map(([day, source, reference, title, hour, minute], index) => ({
        id: `demo-log-${index}`, source, reference, title,
        createdAt: at(days[day], 8), completedAt: at(days[day], hour, minute),
      })),
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

// 校验本机缓存，避免旧数据或损坏数据让页面无法打开。
export function decodeSnapshot(raw: string): WorkbenchState | null {
  try {
    const state: unknown = JSON.parse(raw)
    if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.tasks)) return null
    const ids = new Set<string>()
    for (const task of state.tasks) {
      if (!isRecord(task)
        || typeof task.id !== 'string' || !task.id || ids.has(task.id)
        || typeof task.reference !== 'string'
        || typeof task.source !== 'string' || !Object.hasOwn(SOURCES, task.source)
        || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 300
        || !validTimestamp(task.createdAt)
        || (task.completedAt !== null && !validTimestamp(task.completedAt))
        || (task.recordedAt != null && !validTimestamp(task.recordedAt))) return null
      ids.add(task.id)
    }
    return state as unknown as WorkbenchState
  } catch {
    return null
  }
}
