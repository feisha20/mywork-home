import { describe, expect, it, vi } from 'vitest'
import {
  getNextWeeklyDelay,
  getNextMonthlyDelay,
  PeriodicReportScheduler,
} from './periodicReportScheduler.js'

describe('PeriodicReportScheduler 周期报表定时调度计算', () => {
  it('正确计算下一次周报触发时间（当天未到达指定时间）', () => {
    // 2026-10-02 星期五 10:00 (北京时间)，目标是周五 18:00
    const now = new Date('2026-10-02T10:00:00+08:00')
    const result = getNextWeeklyDelay(5, '18:00', now)
    expect(result).not.toBeNull()
    expect(result?.targetDay).toBe('2026-10-02')
    expect(result?.targetTime).toBe('18:00')
    expect(result?.delayMs).toBe(8 * 3600 * 1000)
  })

  it('正确计算下一次周报触发时间（当天时间已过，跳到下一周）', () => {
    // 2026-10-02 星期五 19:00 (北京时间)，目标是周五 18:00
    const now = new Date('2026-10-02T19:00:00+08:00')
    const result = getNextWeeklyDelay(5, '18:00', now)
    expect(result).not.toBeNull()
    // 下周五是 2026-10-09
    expect(result?.targetDay).toBe('2026-10-09')
    expect(result?.targetTime).toBe('18:00')
  })

  it('正确计算下一次周报触发时间（非目标周几）', () => {
    // 2026-09-30 星期三 10:00 (北京时间)，目标是周五 18:00
    const now = new Date('2026-09-30T10:00:00+08:00')
    const result = getNextWeeklyDelay(5, '18:00', now)
    expect(result).not.toBeNull()
    expect(result?.targetDay).toBe('2026-10-02')
    expect(result?.targetTime).toBe('18:00')
  })

  it('正确计算下一次月报触发时间（当月月末未到达）', () => {
    // 2026-10-15 12:00 (北京时间)，目标每月最后一天 18:00
    const now = new Date('2026-10-15T12:00:00+08:00')
    const result = getNextMonthlyDelay('18:00', now)
    expect(result).not.toBeNull()
    // 10月有 31 天
    expect(result?.targetDay).toBe('2026-10-31')
    expect(result?.targetTime).toBe('18:00')
  })

  it('正确计算下一次月报触发时间（当月月末已过，推到下月月末）', () => {
    // 2026-10-31 19:00 (北京时间)，目标每月最后一天 18:00
    const now = new Date('2026-10-31T19:00:00+08:00')
    const result = getNextMonthlyDelay('18:00', now)
    expect(result).not.toBeNull()
    // 11月有 30 天
    expect(result?.targetDay).toBe('2026-11-30')
    expect(result?.targetTime).toBe('18:00')
  })
})

describe('PeriodicReportScheduler 实例调度与响应配置更新', () => {
  it('正确启动定时器并能根据设置动态开关与关闭', async () => {
    const mockSettings = {
      periodicReportSchedule: vi.fn(() => ({
        weeklyEnabled: true,
        weeklyDay: 5,
        weeklyTime: '18:00',
        monthlyEnabled: true,
        monthlyTime: '18:00',
      })),
      subscribe: vi.fn(() => () => {}),
    }

    const mockStore = {
      tasks: vi.fn(async () => []),
      dailyReports: vi.fn(async () => []),
      savePeriodicReport: vi.fn(async () => ({})),
    }

    const scheduler = new PeriodicReportScheduler(mockStore as any, mockSettings as any)
    scheduler.start()
    expect(scheduler.nextWeeklyRun).not.toBeNull()
    expect(scheduler.nextMonthlyRun).not.toBeNull()

    await scheduler.close()
    expect(scheduler.nextWeeklyRun).toBeNull()
    expect(scheduler.nextMonthlyRun).toBeNull()
  })
})
