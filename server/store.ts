import type { Pool, PoolClient } from 'pg'
import type { Task } from '../src/domain/workbench.js'
import type { DailyReport, Evidence, SyncRun, RecordQuery, RecordPage, ReportJob } from '../shared/contracts.js'
import type { Cursor, Source, SourceMessage } from './records.js'
import type { PeriodicReportModel } from '../src/domain/periodicReport.js'
import type { ZentaoSnapshot, ZentaoTrackedItem } from './zentao.js'
import { ZentaoManagementStore } from './zentaoManagementStore.js'
import {
  jobFromRow,
  taskFromRow,
  recordDateSql,
  taskSummaryColumns,
  visibleManagementSql,
  withTransaction,
  type ExtractedItem,
} from './repositories/db.js'
import { TaskRepository } from './repositories/taskRepository.js'
import { CursorRepository } from './repositories/cursorRepository.js'
import { EvidenceRepository } from './repositories/evidenceRepository.js'
import { ReportRepository } from './repositories/reportRepository.js'
import { SyncRunRepository } from './repositories/syncRunRepository.js'

export {
  jobFromRow,
  taskFromRow,
  recordDateSql,
  taskSummaryColumns,
  visibleManagementSql,
  withTransaction,
  type ExtractedItem,
}

export class Store {
  readonly management: ZentaoManagementStore
  readonly tasksRepo: TaskRepository
  readonly cursorsRepo: CursorRepository
  readonly evidenceRepo: EvidenceRepository
  readonly reportsRepo: ReportRepository
  readonly syncRunsRepo: SyncRunRepository

  constructor(readonly pool: Pool) {
    this.management = new ZentaoManagementStore(pool, taskFromRow)
    this.tasksRepo = new TaskRepository(pool, () => this.management)
    this.cursorsRepo = new CursorRepository(pool)
    this.evidenceRepo = new EvidenceRepository(pool, (client, tasks) =>
      this.tasksRepo.updatePersonalReports(client, tasks),
    )
    this.reportsRepo = new ReportRepository(pool)
    this.syncRunsRepo = new SyncRunRepository(pool)
  }

  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, action)
  }

  // --- TaskRepository delegations ---
  async tasks(): Promise<Task[]> {
    return this.tasksRepo.tasks()
  }

  async snapshotTasks(day: string): Promise<Task[]> {
    return this.tasksRepo.snapshotTasks(day)
  }

  async recordedDays(): Promise<string[]> {
    return this.tasksRepo.recordedDays()
  }

  async recordPage(input: RecordQuery): Promise<RecordPage> {
    return this.tasksRepo.recordPage(input)
  }

  async projectTasks(path: string): Promise<Task[]> {
    return this.tasksRepo.projectTasks(path)
  }

  async periodTasks(startDate: string, endDate: string): Promise<Task[]> {
    return this.tasksRepo.periodTasks(startDate, endDate)
  }

  async createTask(title: string, isPersonal = false): Promise<Task> {
    return this.tasksRepo.createTask(title, isPersonal)
  }

  async setPinned(id: string, isPinned: boolean): Promise<Task | null> {
    return this.tasksRepo.setPinned(id, isPinned)
  }

  async setPersonal(id: string, isPersonal: boolean): Promise<Task | null> {
    return this.tasksRepo.setPersonal(id, isPersonal)
  }

  async setCompleted(id: string, completed: boolean): Promise<Task | null> {
    return this.tasksRepo.setCompleted(id, completed)
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.tasksRepo.deleteTask(id)
  }

  async importTasks(tasks: Task[]): Promise<{ imported: number; duplicates: number }> {
    return this.tasksRepo.importTasks(tasks)
  }

  async applySummaries(tasks: Task[], items: { taskId: string; title: string }[]): Promise<number> {
    return this.tasksRepo.applySummaries(tasks, items)
  }

  async zentaoTrackedItems(instance: string, account: string): Promise<ZentaoTrackedItem[]> {
    return this.tasksRepo.zentaoTrackedItems(instance, account)
  }

  async applyZentaoSnapshot(snapshot: ZentaoSnapshot): Promise<{ created: number; updated: number }> {
    return this.tasksRepo.applyZentaoSnapshot(snapshot)
  }

  async zentaoPendingCount(instance?: string, account?: string): Promise<number> {
    return this.tasksRepo.zentaoPendingCount(instance, account)
  }

  // --- CursorRepository delegations ---
  async cutoff(): Promise<string> {
    return this.cursorsRepo.cutoff()
  }

  async cursor(path: string): Promise<Cursor | null> {
    return this.cursorsRepo.cursor(path)
  }

  async recordIgnored(path: string, fingerprint: string): Promise<boolean> {
    return this.cursorsRepo.recordIgnored(path, fingerprint)
  }

  async failRecord(path: string, source: Source, fingerprint: string, runId: string): Promise<number> {
    return this.cursorsRepo.failRecord(path, source, fingerprint, runId)
  }

  async clearRecordFailure(path: string): Promise<void> {
    return this.cursorsRepo.clearRecordFailure(path)
  }

  // --- EvidenceRepository delegations ---
  batchId(messages: SourceMessage[]): string {
    return this.evidenceRepo.batchId(messages)
  }

  async ingest(messages: SourceMessage[], cursor: Cursor, reconcile = false): Promise<number> {
    return this.evidenceRepo.ingest(messages, cursor, reconcile)
  }

  async pendingMessages(sources?: string[], after?: { timestamp: string; id: string }, limit = 500): Promise<SourceMessage[]> {
    return this.evidenceRepo.pendingMessages(sources, after, limit)
  }

  async resolveRoot(source: string, sessionId: string): Promise<string> {
    return this.evidenceRepo.resolveRoot(source, sessionId)
  }

  async contextMessages(source: string, root: string, before: string, projectPath: string): Promise<SourceMessage[]> {
    return this.evidenceRepo.contextMessages(source, root, before, projectPath)
  }

  async startBatch(id: string, key: string, messages: SourceMessage[]): Promise<boolean> {
    return this.evidenceRepo.startBatch(id, key, messages)
  }

  async failBatch(id: string, error: string): Promise<void> {
    return this.evidenceRepo.failBatch(id, error)
  }

  async applyExtraction(batchId: string, messages: SourceMessage[], context: SourceMessage[], items: ExtractedItem[]): Promise<{ created: number; updated: number }> {
    return this.evidenceRepo.applyExtraction(batchId, messages, context, items)
  }

  async taskEvidence(id: string): Promise<Evidence[] | null> {
    return this.evidenceRepo.taskEvidence(id)
  }

  // --- ReportRepository delegations ---
  async reportRecords(day: string): Promise<Task[]> {
    return this.reportsRepo.reportRecords(day)
  }

  async dailyReport(day: string): Promise<DailyReport | null> {
    return this.reportsRepo.dailyReport(day)
  }

  async dailyReports(startDate?: string, endDate?: string): Promise<DailyReport[]> {
    return this.reportsRepo.dailyReports(startDate, endDate)
  }

  async saveDailyReport(report: DailyReport, expectedRevision: number): Promise<DailyReport | null> {
    return this.reportsRepo.saveDailyReport(report, expectedRevision)
  }

  async periodicReports(): Promise<PeriodicReportModel[]> {
    return this.reportsRepo.periodicReports()
  }

  async periodicReport(type: 'weekly' | 'monthly', key: string): Promise<PeriodicReportModel | null> {
    return this.reportsRepo.periodicReport(type, key)
  }

  async savePeriodicReport(report: PeriodicReportModel, expectedRevision: number, scopeSnapshot?: Task[]): Promise<PeriodicReportModel | null> {
    return this.reportsRepo.savePeriodicReport(report, expectedRevision, scopeSnapshot)
  }

  // --- SyncRunRepository delegations ---
  async dataVersion(): Promise<string> {
    return this.syncRunsRepo.dataVersion()
  }

  async saveRun(run: SyncRun): Promise<void> {
    return this.syncRunsRepo.saveRun(run)
  }

  async latestRun(): Promise<SyncRun | null> {
    return this.syncRunsRepo.latestRun()
  }

  async run(id: string): Promise<SyncRun | null> {
    return this.syncRunsRepo.run(id)
  }

  async interruptRuns(): Promise<void> {
    return this.syncRunsRepo.interruptRuns()
  }

  async sourceCounts(): Promise<{ source: Source; count: number }[]> {
    return this.syncRunsRepo.sourceCounts()
  }

  async scheduleCheckpoint(): Promise<string | null> {
    return this.syncRunsRepo.scheduleCheckpoint()
  }

  async enqueueReportJobs(jobs: ReportJob[], checkpoint: string): Promise<void> {
    return this.syncRunsRepo.enqueueReportJobs(jobs, checkpoint)
  }

  async claimReportJob(kinds: string[], token: string): Promise<ReportJob | null> {
    return this.syncRunsRepo.claimReportJob(kinds, token)
  }

  async finishReportJob(id: string, token: string, status: 'succeeded' | 'failed' | 'skipped', error: string | null = null): Promise<void> {
    return this.syncRunsRepo.finishReportJob(id, token, status, error)
  }

  async renewReportJob(id: string, token: string): Promise<void> {
    return this.syncRunsRepo.renewReportJob(id, token)
  }

  async retryReportJob(id: string): Promise<boolean> {
    return this.syncRunsRepo.retryReportJob(id)
  }

  async reportJobs(): Promise<ReportJob[]> {
    return this.syncRunsRepo.reportJobs()
  }
}
