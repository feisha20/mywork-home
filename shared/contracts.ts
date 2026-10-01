import type { Task } from '../src/domain/workbench.js'

export interface Evidence {
  messageId: string
  sessionId: string
  source: 'codex' | 'claude'
  projectPath: string
  timestamp: string
  quote: string
}

export type SyncPhase = 'scanning' | 'extracting' | 'saving' | 'idle'
export interface SyncRun {
  id: string
  status: 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'interrupted'
  phase: SyncPhase
  startedAt: string
  finishedAt: string | null
  scannedFiles: number
  newMessages: number
  newTasks: number
  updatedTasks: number
  failedBatches: number
  errors: string[]
}

export interface WorkbenchSnapshot {
  version: 1
  tasks: Task[]
  harness: { run: SyncRun | null; nextSyncAt: string | null; model: string }
  sources: Record<'codex' | 'claude', { available: boolean; sessionCount: number; error: string | null }>
}
