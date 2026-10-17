import { aggregatePeriodData, periodBounds, synthesizePeriodicReport, periodicMarkdownSections } from '../src/domain/periodicReport.js'
import type { Store } from './store.js'
import type { PeriodicReportGenerator } from './periodicReportSummary.js'
import { ModelConnectionError } from './modelRouting.js'

export class PeriodicReportError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message) }
}

// 仅使用固定类别提示，不向页面或日志回显上游正文、地址或凭证。
export function periodicReportFailure(error: unknown): { message: string; statusCode: number } {
  const suffix = '；原有报告已保留'
  const message = error instanceof Error ? error.message : ''
  if (/尚未配置.*(?:密钥|模型)/.test(message)) return { message: `尚未配置可用模型，请在设置中配置后重新整理${suffix}`, statusCode: 503 }
  if (message === '所有模型暂时不可用，请在一分钟后重试') return { message: `模型服务暂时不可用，请一分钟后重试${suffix}`, statusCode: 503 }
  if (error instanceof ModelConnectionError) return { message: `${/超时/.test(message) ? '周月报生成超时，模型未在时限内完成' : '周月报模型连接失败，请检查模型服务及额度'}${suffix}`, statusCode: 502 }
  if (error instanceof Error && 'validationFeedback' in error && typeof error.validationFeedback === 'string') {
    const feedback = error.validationFeedback
    const reason = feedback.includes('遗漏成果素材') ? '模型遗漏了部分成果素材'
      : feedback.includes('未知或重复') ? '模型引用了未知或重复的成果素材'
        : feedback.includes('相同项目主题') ? '模型没有合并重复项目主题'
          : feedback.includes('未知素材') ? '模型引用了不存在的计划或风险依据'
            : feedback.includes('JSON格式无效') ? '模型未返回完整有效的 JSON'
              : '模型输出未满足月报格式要求'
    return { message: `周月报归纳校验失败：${reason}${suffix}`, statusCode: 502 }
  }
  return { message: `周月报归纳失败，请稍后重新整理${suffix}`, statusCode: 502 }
}
type PeriodStore = Pick<Store, 'periodTasks' | 'dailyReports' | 'periodicReport' | 'periodicReports' | 'savePeriodicReport'>
export class PeriodicReportService {
  constructor(private store: PeriodStore, private generator?: PeriodicReportGenerator) {}
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
    const data = aggregatePeriodData(bounds.startDate, bounds.endDate, dailyReports, tasks)
    if (this.generator && (data.matchedReports.length || data.completedTasks.length || data.pendingTasks.length)) {
      try {
        report.sections = await this.generator.generatePeriodicReport(type, data)
        report.markdown = [report.markdown.split('\n').slice(0, 2).join('\n'), ...report.sections.map((section) =>
          `### ${section.title}\n\n${section.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`)].join('\n\n')
      } catch (error) {
        const failure = periodicReportFailure(error)
        console.warn('周月报归纳失败', JSON.stringify({ type, periodKey: key, reason: failure.message }))
        throw new PeriodicReportError(failure.message, failure.statusCode)
      }
    }
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
  async close() { await this.generator?.close() }
}
