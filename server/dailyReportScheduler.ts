import { DailyReportError, type DailyReportService } from './dailyReport.js'
import type { SettingsService } from './settings.js'
import type { DailyReport } from '../shared/contracts.js'

export interface ScheduleDelayResult {
  delayMs: number
  targetDay: string
  targetTime: string
  targetTimestamp: number
}

export function beijingParts(date = new Date()) {
  const beijingDate = new Date(date.getTime() + 8 * 3600 * 1000)
  const year = beijingDate.getUTCFullYear()
  const month = String(beijingDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(beijingDate.getUTCDate()).padStart(2, '0')
  const hour = String(beijingDate.getUTCHours()).padStart(2, '0')
  const minute = String(beijingDate.getUTCMinutes()).padStart(2, '0')
  return {
    dayKey: `${year}-${month}-${day}`,
    timeKey: `${hour}:${minute}`,
  }
}

export function getNextScheduleDelay(times: string[], now = new Date()): ScheduleDelayResult | null {
  const sorted = [...new Set(times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort()
  if (sorted.length === 0) return null

  const current = beijingParts(now)
  // 查找今天严格晚于当前分钟的时间点
  const nextToday = sorted.find((time) => time > current.timeKey)

  let targetDay: string
  let targetTime: string

  if (nextToday) {
    targetDay = current.dayKey
    targetTime = nextToday
  } else {
    // 今天的设定时间都已过去，安排到明天的第一个时间点
    const tomorrow = beijingParts(new Date(now.getTime() + 24 * 3600 * 1000))
    targetDay = tomorrow.dayKey
    targetTime = sorted[0]
  }

  const targetTimestamp = Date.parse(`${targetDay}T${targetTime}:00+08:00`)
  const delayMs = Math.max(1000, targetTimestamp - now.getTime())

  return { delayMs, targetDay, targetTime, targetTimestamp }
}

export class DailyReportScheduler {
  private timer: NodeJS.Timeout | null = null
  private stopping = false
  private active: Promise<DailyReport | null> | null = null
  private unsubscribe: (() => void) | undefined
  nextRun: { day: string; time: string; timestamp: number } | null = null

  constructor(
    private reports: DailyReportService,
    private settings: SettingsService,
  ) {
    this.unsubscribe = settings.subscribe(() => this.reschedule())
  }

  start() {
    this.schedule()
  }

  private reschedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextRun = null
    if (!this.stopping) {
      this.schedule()
    }
  }

  private schedule() {
    if (this.stopping) return
    const schedule = this.settings.dailyReportSchedule()
    if (!schedule.enabled || schedule.times.length === 0) {
      return
    }

    const next = getNextScheduleDelay(schedule.times)
    if (!next) return

    this.nextRun = { day: next.targetDay, time: next.targetTime, timestamp: next.targetTimestamp }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.execute(next.targetDay)
    }, next.delayMs)
    this.timer.unref()
  }

  private async execute(day: string) {
    if (this.stopping) return
    try {
      this.active = this.trigger(day)
      await this.active
    } finally {
      this.active = null
      if (!this.stopping) {
        this.schedule()
      }
    }
  }

  async trigger(day: string): Promise<DailyReport | null> {
    try {
      return await this.reports.generate(day, 'append')
    } catch (error) {
      if (error instanceof DailyReportError && error.statusCode === 400) {
        // 这一天还没有工作日志，无需报错，静默跳过
        return null
      }
      console.error(`[自动日报] 自动生成 ${day} 日报失败：`, error)
      return null
    }
  }

  async close() {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextRun = null
    this.unsubscribe?.()
    if (this.active) {
      await this.active.catch(() => {})
    }
  }
}
