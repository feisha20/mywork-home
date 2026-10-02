import type { Task } from '../src/domain/workbench.js'
import type { ChannelSummary } from './settings.js'

export type SessionSource = Exclude<Task['source'], 'manual' | 'zentao'>

export interface Evidence {
  messageId: string
  sessionId: string
  source: SessionSource
  projectPath: string
  timestamp: string
  quote: string
}

export interface DailyReportItem {
  text: string
  taskIds: string[]
  topic?: string
  projectPaths?: string[]
}

export interface DailyReport {
  day: string
  generatedAt: string
  recordCount: number
  items: DailyReportItem[]
  revision: number
  recordVersions: Record<string, string>
}

export type SyncPhase = 'scanning' | 'extracting' | 'saving' | 'idle'
export interface SyncRun {
  id: string
  status: 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'interrupted'
  phase: SyncPhase
  activeSource?: SessionSource | null
  startedAt: string
  finishedAt: string | null
  scannedFiles: number
  newMessages: number
  newTasks: number
  updatedTasks: number
  failedBatches: number
  ignoredFiles?: number
  skippedRecords?: number
  errors: string[]
}

export interface WorkbenchSnapshot {
  version: 1
  tasks: Task[]
  dailyReports: DailyReport[]
  harness: { run: SyncRun | null; nextSyncAt: string | null; model: string; intervalMs?: number; autoSyncEnabled?: boolean }
  channels?: ChannelSummary[]
  sources: Record<SessionSource, SourceStatus> & { zentao?: SourceStatus }
}

export interface SourceStatus { available: boolean; sessionCount: number; error: string | null; enabled?: boolean; collector?: string }
