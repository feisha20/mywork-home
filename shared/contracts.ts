import type { Task } from '../src/domain/workbench.js'
import type { ChannelSummary } from './settings.js'
import type { ModelUsage } from './modelUsage.js'

export type SessionSource = Exclude<Task['source'], 'manual' | 'zentao'>

export interface Evidence {
  messageId: string
  sessionId: string
  source: SessionSource
  projectPath: string
  timestamp: string
  quote: string
  valid?: boolean
  invalidReason?: 'edited' | 'withdrawn'
}

export interface DailyReportItem {
  text: string
  taskIds: string[]
  topic?: string
  subItems?: string[]
  projectPaths?: string[]
  localTemplate?: 'zentao-management'
}

export interface DailyReport {
  day: string
  generatedAt: string
  recordCount: number
  items: DailyReportItem[]
  revision: number
  recordVersions: Record<string, string>
  edited?: boolean
}

export type SyncPhase = 'scanning' | 'extracting' | 'saving' | 'idle'
export interface SyncRun {
  id: string
  status: 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'interrupted'
  phase: SyncPhase
  activeSource?: Exclude<Task['source'], 'manual'> | null
  startedAt: string
  finishedAt: string | null
  scannedFiles: number
  newMessages: number
  newTasks: number
  updatedTasks: number
  failedBatches: number
  processedBatches?: number
  ignoredFiles?: number
  skippedRecords?: number
  errors: string[]
}

export interface WorkbenchSnapshot {
  version: 1
  recordedDays?: string[]
  dataVersion?: string
  tasks: Task[]
  dailyReports: DailyReport[]
  harness: { run: SyncRun | null; nextSyncAt: string | null; model: string; modelUsage?: ModelUsage; intervalMs?: number; autoSyncEnabled?: boolean }
  channels?: ChannelSummary[]
  sources: Record<SessionSource, SourceStatus> & { zentao?: SourceStatus }
}

export interface SourceStatus { available: boolean; sessionCount: number; error: string | null; enabled?: boolean; collector?: string }

export interface RecordQuery {
  onlyRecords?: boolean
  startDate?: string
  endDate?: string
  offset?: number
  limit?: number
}
export interface RecordPage { tasks: Task[]; total: number; offset: number; limit: number }
// 界面命令面板的跨周期检索：不限定日期范围，按记录日期归类待办与日志。
export interface SearchQuery {
  query?: string
  source?: string
  kind?: 'all' | 'todo' | 'log'
  status?: 'pending' | 'completed' | 'recorded' | 'needs_review'
  offset?: number
  limit?: number
}
export interface SearchHit extends Record<string, unknown> {
  task: Task
  // 事项所属的日志日期（北京时间），待办为 null，用于跳转到对应日历日。
  day: string | null
}
export interface SearchPage { hits: SearchHit[]; total: number; offset: number; limit: number }
export interface ReportJob {
  id: string; kind: 'daily' | 'weekly' | 'monthly'; day: string; periodKey: string
  scheduledAt: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  attempts: number; error: string | null; finishedAt: string | null
}
