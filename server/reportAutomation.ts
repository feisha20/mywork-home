import { randomUUID } from 'node:crypto'
import { dateFromKey, dateKey } from '../src/domain/workbench.js'
import { getMonthBounds, getWeekBounds, shiftDay } from '../src/domain/periodicReport.js'
import type { ReportJob } from '../shared/contracts.js'
import type { SettingsService } from './settings.js'
import type { Store } from './store.js'
import type { DailyReportService } from './dailyReport.js'
import type { PeriodicReportService } from './periodicReport.js'
import { DailyReportError } from './dailyReport.js'

type JobStore = Pick<Store, 'scheduleCheckpoint' | 'enqueueReportJobs' | 'claimReportJob' | 'renewReportJob' | 'finishReportJob'>
type Schedules = Pick<SettingsService, 'dailyReportSchedule' | 'periodicReportSchedule'>
type AutomationSettings = Schedules & Pick<SettingsService, 'subscribe'>
export function dueReportJobs(from: Date, to: Date, settings: Schedules): ReportJob[] {
  const daily = settings.dailyReportSchedule(), period = settings.periodicReportSchedule(), jobs: ReportJob[] = []
  const add = (kind: ReportJob['kind'], day: string, time: string, periodKey: string) => {
    const scheduledAt = new Date(`${day}T${time}:00+08:00`).toISOString()
    if (scheduledAt <= from.toISOString() || scheduledAt > to.toISOString()) return
    jobs.push({ id: `${kind}:${scheduledAt}`, kind, day, periodKey, scheduledAt, status: 'pending', attempts: 0, error: null, finishedAt: null })
  }
  for (let day = dateKey(from); day <= dateKey(to); day = shiftDay(day, 1)) {
    if (daily.enabled) for (const time of daily.times) add('daily', day, time, day)
    const date = dateFromKey(day), weekday = new Date(`${day}T12:00:00Z`).getUTCDay() || 7
    if (period.weeklyEnabled && weekday === period.weeklyDay) add('weekly', day, period.weeklyTime, getWeekBounds(date).weekKey)
    if (period.monthlyEnabled && day === getMonthBounds(date).endDate) add('monthly', day, period.monthlyTime, getMonthBounds(date).monthKey)
  }
  return jobs.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || (a.kind === 'daily' ? -1 : b.kind === 'daily' ? 1 : a.kind.localeCompare(b.kind)))
}
export class ReportAutomation {
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | null = null
  private stopped = false
  private rescan = false
  private unsubscribe: () => void
  constructor(private store: JobStore, private settings: AutomationSettings, private daily: Pick<DailyReportService, 'generateQueued'>,
    private periodic: Pick<PeriodicReportService, 'generate'>, private ready: () => Promise<void> = async () => {}) {
    this.unsubscribe = settings.subscribe(() => { this.rescan = true; this.wake() })
  }
  start() { this.wake() }
  wake() {
    if (this.stopped || this.active) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().catch(() => console.error('自动整理调度暂时失败，一分钟后重试')).finally(() => {
        if (!this.stopped) { if (this.rescan) this.wake(); else { this.timer = setTimeout(() => this.wake(), 60_000); this.timer.unref?.() } }
      })
    }, 1000)
    this.timer.unref?.()
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.active) return this.active
    this.active = this.run().finally(() => { this.active = null })
    return this.active
  }
  private async run() {
    await this.ready()
    if (this.stopped) return
    const now = new Date(), checkpoint = await this.store.scheduleCheckpoint()
    // 首次启用回溯七天；已有检查点时补齐全部遗漏，不回退已完成任务。
    const from = checkpoint && !this.rescan ? new Date(checkpoint) : new Date(now.getTime() - 7 * 86400000)
    this.rescan = false
    await this.store.enqueueReportJobs(dueReportJobs(from, now, this.settings), now.toISOString())
    for (let count = 0; count < 20 && !this.stopped; count++) {
      const daily = this.settings.dailyReportSchedule(), period = this.settings.periodicReportSchedule()
      const kinds = [daily.enabled ? 'daily' : '', period.weeklyEnabled ? 'weekly' : '', period.monthlyEnabled ? 'monthly' : ''].filter(Boolean)
      const token = randomUUID(), job = await this.store.claimReportJob(kinds, token)
      if (!job) break
      const heartbeat = setInterval(() => { void this.store.renewReportJob(job.id, token).catch(() => {}) }, 60_000)
      heartbeat.unref?.()
      try {
        if (job.kind === 'daily') await this.daily.generateQueued(job.day)
        else await this.periodic.generate(job.kind, job.periodKey, undefined, true)
        await this.store.finishReportJob(job.id, token, 'succeeded')
      } catch (error) {
        const empty = error instanceof DailyReportError && error.statusCode === 400
        // 仅保存本系统定义的简短错误，不持久化模型正文、SQL 或连接凭证。
        const message = error instanceof DailyReportError ? error.message : '报告整理失败，原有报告已保留；将自动重试，也可手动重试'
        await this.store.finishReportJob(job.id, token, empty ? 'skipped' : 'failed', empty ? '该日期没有工作日志' : message)
      } finally { clearInterval(heartbeat) }
    }
  }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.unsubscribe(); await this.active }
}
