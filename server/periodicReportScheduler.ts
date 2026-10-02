import type { Store } from './store.js'
import type { SettingsService } from './settings.js'
import {
  getMonthBounds,
  getWeekBounds,
  synthesizePeriodicReport,
} from '../src/domain/periodicReport.js'

export interface PeriodicScheduleDelayResult {
  delayMs: number
  targetDay: string
  targetTime: string
  targetTimestamp: number
}

// 北京时间转换辅助
function beijingDate(now = new Date()): Date {
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60 * 1000)
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getNextWeeklyDelay(
  weeklyDay: number, // 1=周一, 5=周五, 7=周日
  weeklyTime: string, // '18:00'
  now = new Date()
): PeriodicScheduleDelayResult | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(weeklyTime)) return null
  if (weeklyDay < 1 || weeklyDay > 7) return null

  const bjNow = beijingDate(now)
  // getDay(): 0 is Sunday, 1-6 is Monday-Saturday -> 转为 1-7
  const currentDayOfWeek = bjNow.getDay() === 0 ? 7 : bjNow.getDay()
  const currentTime = `${String(bjNow.getHours()).padStart(2, '0')}:${String(bjNow.getMinutes()).padStart(2, '0')}`

  let dayDiff = weeklyDay - currentDayOfWeek
  if (dayDiff < 0 || (dayDiff === 0 && currentTime >= weeklyTime)) {
    // 已经错过本周目标时间，安排到下周
    dayDiff += 7
  }

  const targetDate = new Date(bjNow)
  targetDate.setDate(bjNow.getDate() + dayDiff)
  const targetDay = formatDate(targetDate)

  const targetTimestamp = Date.parse(`${targetDay}T${weeklyTime}:00+08:00`)
  const delayMs = Math.max(1000, targetTimestamp - now.getTime())

  return { delayMs, targetDay, targetTime: weeklyTime, targetTimestamp }
}

export function getNextMonthlyDelay(
  monthlyTime: string, // '18:00'
  now = new Date()
): PeriodicScheduleDelayResult | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(monthlyTime)) return null

  const bjNow = beijingDate(now)
  const currentYear = bjNow.getFullYear()
  const currentMonth = bjNow.getMonth() // 0-based

  // 当月最后一天
  const lastDayThisMonth = new Date(currentYear, currentMonth + 1, 0).getDate()
  const thisMonthTargetDay = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(lastDayThisMonth).padStart(2, '0')}`
  const thisMonthTimestamp = Date.parse(`${thisMonthTargetDay}T${monthlyTime}:00+08:00`)

  let targetTimestamp: number
  let targetDay: string

  if (now.getTime() < thisMonthTimestamp) {
    targetTimestamp = thisMonthTimestamp
    targetDay = thisMonthTargetDay
  } else {
    // 安排到下月最后一天
    const nextMonth = currentMonth + 1
    const nextYear = currentYear + Math.floor(nextMonth / 12)
    const nextMonthNormalized = nextMonth % 12
    const lastDayNextMonth = new Date(nextYear, nextMonthNormalized + 1, 0).getDate()
    targetDay = `${nextYear}-${String(nextMonthNormalized + 1).padStart(2, '0')}-${String(lastDayNextMonth).padStart(2, '0')}`
    targetTimestamp = Date.parse(`${targetDay}T${monthlyTime}:00+08:00`)
  }

  const delayMs = Math.max(1000, targetTimestamp - now.getTime())
  return { delayMs, targetDay, targetTime: monthlyTime, targetTimestamp }
}

export class PeriodicReportScheduler {
  private weeklyTimer: NodeJS.Timeout | null = null
  private monthlyTimer: NodeJS.Timeout | null = null
  private stopping = false
  private unsubscribe: (() => void) | undefined

  nextWeeklyRun: { day: string; time: string; timestamp: number } | null = null
  nextMonthlyRun: { day: string; time: string; timestamp: number } | null = null

  constructor(
    private store: Store,
    private settings: SettingsService
  ) {
    this.unsubscribe = settings.subscribe(() => this.reschedule())
  }

  start() {
    this.stopping = false
    this.scheduleWeekly()
    this.scheduleMonthly()
  }

  async close() {
    this.stopping = true
    if (this.weeklyTimer) {
      clearTimeout(this.weeklyTimer)
      this.weeklyTimer = null
    }
    if (this.monthlyTimer) {
      clearTimeout(this.monthlyTimer)
      this.monthlyTimer = null
    }
    this.nextWeeklyRun = null
    this.nextMonthlyRun = null
    this.unsubscribe?.()
  }

  private reschedule() {
    if (this.stopping) return
    this.scheduleWeekly()
    this.scheduleMonthly()
  }

  private scheduleWeekly() {
    if (this.weeklyTimer) {
      clearTimeout(this.weeklyTimer)
      this.weeklyTimer = null
    }
    const schedule = this.settings.periodicReportSchedule()
    if (!schedule.weeklyEnabled) {
      this.nextWeeklyRun = null
      return
    }

    const next = getNextWeeklyDelay(schedule.weeklyDay, schedule.weeklyTime)
    if (!next) {
      this.nextWeeklyRun = null
      return
    }

    this.nextWeeklyRun = { day: next.targetDay, time: next.targetTime, timestamp: next.targetTimestamp }
    const maxSafeDelay = 2147483647 // 约 24.8 天，setTimeout 最大安全值
    const waitMs = Math.min(next.delayMs, maxSafeDelay)

    this.weeklyTimer = setTimeout(() => {
      this.weeklyTimer = null
      if (this.stopping) return
      if (next.delayMs > maxSafeDelay) {
        // 如果超过最大安全延时，重新分段调度
        this.scheduleWeekly()
        return
      }
      void this.triggerWeekly(next.targetDay).finally(() => {
        if (!this.stopping) this.scheduleWeekly()
      })
    }, waitMs)
    this.weeklyTimer.unref?.()
  }

  private scheduleMonthly() {
    if (this.monthlyTimer) {
      clearTimeout(this.monthlyTimer)
      this.monthlyTimer = null
    }
    const schedule = this.settings.periodicReportSchedule()
    if (!schedule.monthlyEnabled) {
      this.nextMonthlyRun = null
      return
    }

    const next = getNextMonthlyDelay(schedule.monthlyTime)
    if (!next) {
      this.nextMonthlyRun = null
      return
    }

    this.nextMonthlyRun = { day: next.targetDay, time: next.targetTime, timestamp: next.targetTimestamp }
    const maxSafeDelay = 2147483647
    const waitMs = Math.min(next.delayMs, maxSafeDelay)

    this.monthlyTimer = setTimeout(() => {
      this.monthlyTimer = null
      if (this.stopping) return
      if (next.delayMs > maxSafeDelay) {
        this.scheduleMonthly()
        return
      }
      void this.triggerMonthly(next.targetDay).finally(() => {
        if (!this.stopping) this.scheduleMonthly()
      })
    }, waitMs)
    this.monthlyTimer.unref?.()
  }

  async triggerWeekly(referenceDay: string) {
    try {
      const refDate = new Date(`${referenceDay}T12:00:00+08:00`)
      const bounds = getWeekBounds(refDate)
      const tasks = await this.store.tasks()
      const dailyReports = await this.store.dailyReports()

      const report = synthesizePeriodicReport('weekly', {
        label: bounds.label,
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        key: bounds.weekKey,
      }, dailyReports, tasks)

      await (this.store as any).savePeriodicReport?.(report)
    } catch {
      // 静默处理自动定时生成错误
    }
  }

  async triggerMonthly(referenceDay: string) {
    try {
      const refDate = new Date(`${referenceDay}T12:00:00+08:00`)
      const bounds = getMonthBounds(refDate)
      const tasks = await this.store.tasks()
      const dailyReports = await this.store.dailyReports()

      const report = synthesizePeriodicReport('monthly', {
        label: bounds.label,
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        key: bounds.monthKey,
      }, dailyReports, tasks)

      await (this.store as any).savePeriodicReport?.(report)
    } catch {
      // 静默处理自动定时生成错误
    }
  }
}
