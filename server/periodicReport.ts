import { aggregatePeriodData, periodBounds, synthesizePeriodicReport, periodicMarkdownSections } from '../src/domain/periodicReport.js'
import type { Store } from './store.js'

export class PeriodicReportError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message) }
}
type PeriodStore = Pick<Store, 'periodTasks' | 'dailyReports' | 'periodicReport' | 'periodicReports' | 'savePeriodicReport'>
export class PeriodicReportService {
  constructor(private store: PeriodStore) {}
  private bounds(type: 'weekly' | 'monthly', key: string) {
    try { return periodBounds(type, key) } catch { throw new PeriodicReportError('报告周期无效', 400) }
  }
  async material(type: 'weekly' | 'monthly', key: string) {
    const bounds = this.bounds(type, key)
    const [tasks, dailyReports] = await Promise.all([
      this.store.periodTasks(bounds.startDate, bounds.endDate), this.store.dailyReports(bounds.startDate, bounds.endDate),
    ])
    return { bounds, tasks, dailyReports }
  }
  async read(type: 'weekly' | 'monthly', key: string) {
    this.bounds(type, key)
    const report = await this.store.periodicReport(type, key)
    if (report?.needsRefresh && !report.edited) {
      try { return await this.generate(type, key, report.revision) }
      catch (error) {
        // 并发读取可能已由另一请求刷新，直接返回其已保存的新版本。
        if (error instanceof PeriodicReportError && error.statusCode === 409) {
          const latest = await this.store.periodicReport(type, key)
          if (latest && !latest.needsRefresh) return latest
        }
        throw error
      }
    }
    return report
  }
  async generate(type: 'weekly' | 'monthly', key: string, expectedRevision?: number, automatic = false) {
    const previous = await this.store.periodicReport(type, key)
    if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new PeriodicReportError('报告已被更新，请重新载入后再整理', 409)
    // 数据库归档后自动任务应保留人工保存的正文。
    if (automatic && previous?.edited) return previous
    const { bounds, tasks, dailyReports } = await this.material(type, key)
    const report = synthesizePeriodicReport(type, bounds, dailyReports, tasks)
    const saved = await this.store.savePeriodicReport(report, previous?.revision ?? 0, tasks)
    if (!saved) throw new PeriodicReportError('报告已被其他请求更新，请重新载入后再整理', 409)
    return saved
  }
  async edit(type: 'weekly' | 'monthly', key: string, markdown: string, expectedRevision: number) {
    const previous = await this.store.periodicReport(type, key)
    if ((previous?.revision ?? 0) !== expectedRevision) throw new PeriodicReportError('报告已被更新，请重新载入后再保存；当前编辑内容已保留', 409)
    const { bounds, tasks, dailyReports } = await this.material(type, key)
    const baseline = previous ?? synthesizePeriodicReport(type, bounds, dailyReports, tasks)
    const saved = await this.store.savePeriodicReport({ ...baseline, markdown, sections: periodicMarkdownSections(markdown),
      edited: true, needsRefresh: false, mcpMaterialFingerprint: undefined, stats: aggregatePeriodData(bounds.startDate, bounds.endDate, dailyReports, tasks).stats,
      generatedAt: new Date().toISOString() }, expectedRevision, tasks)
    if (!saved) throw new PeriodicReportError('报告已被其他请求更新，当前编辑内容已保留', 409)
    return saved
  }
  async restoreOriginalFormat() {
    // 只恢复上一轮优化生成的自动稿；人工保存正文与更早的原版归档不改写。
    for (const report of await this.store.periodicReports()) {
      if ('sourceVersion' in report && !report.edited) {
        try { await this.generate(report.type, report.periodKey, report.revision) }
        catch (error) { if (!(error instanceof PeriodicReportError && error.statusCode === 409)) throw error }
      }
    }
  }
}
