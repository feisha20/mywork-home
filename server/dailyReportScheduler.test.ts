import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { beijingParts, getNextScheduleDelay, DailyReportScheduler } from './dailyReportScheduler.js'
import { DailyReportError, type DailyReportService } from './dailyReport.js'
import type { SettingsService } from './settings.js'

describe('定时日报时间计算 (Asia/Shanghai 时区)', () => {
  it('正确解析北京时间日期与时间分段', () => {
    // 2026-10-02T04:30:00.000Z 对应北京时间 2026-10-02 12:30
    const date = new Date('2026-10-02T04:30:00.000Z')
    const parts = beijingParts(date)
    expect(parts.dayKey).toBe('2026-10-02')
    expect(parts.timeKey).toBe('12:30')
  })

  it('时间点为空或无效时返回 null', () => {
    expect(getNextScheduleDelay([])).toBeNull()
    expect(getNextScheduleDelay(['invalid'])).toBeNull()
  })

  it('今天还有后续时间点时，选取今天最近的时间点', () => {
    // 2026-10-02 10:15:00 北京时间 (02:15:00Z)
    const now = new Date('2026-10-02T02:15:00.000Z')
    const result = getNextScheduleDelay(['18:00', '12:00', '21:00'], now)
    expect(result).not.toBeNull()
    expect(result?.targetDay).toBe('2026-10-02')
    expect(result?.targetTime).toBe('12:00')
    // 距离 12:00 (04:00:00Z) 还差 1小时45分钟 = 105分钟 = 6,300,000 ms
    expect(result?.delayMs).toBe(105 * 60 * 1000)
  })

  it('今天的设定时间都已过去时，推移至次日第一个时间点', () => {
    // 2026-10-02 21:30:00 北京时间 (13:30:00Z)
    const now = new Date('2026-10-02T13:30:00.000Z')
    const result = getNextScheduleDelay(['12:00', '18:00', '21:00'], now)
    expect(result).not.toBeNull()
    expect(result?.targetDay).toBe('2026-10-03')
    expect(result?.targetTime).toBe('12:00')
    // 从 10-02 21:30 到 10-03 12:00 为 14.5 小时 = 870 分钟 = 52,200,000 ms
    expect(result?.delayMs).toBe(870 * 60 * 1000)
  })
})

describe('DailyReportScheduler 调度器', () => {
  let listeners: (() => void)[]
  let mockSchedule: { enabled: boolean; times: string[] }
  let mockSettings: SettingsService
  let mockReports: DailyReportService

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = []
    mockSchedule = { enabled: true, times: ['12:00', '18:00'] }
    mockSettings = {
      dailyReportSchedule: () => mockSchedule,
      subscribe: (fn: () => void) => {
        listeners.push(fn)
        return () => {
          const index = listeners.indexOf(fn)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    } as unknown as SettingsService

    mockReports = {
      generate: vi.fn().mockResolvedValue({ items: [{ text: '完成工作' }] }),
    } as unknown as DailyReportService
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('启用时成功设定定时器，时间到达后以 append 模式触发生成', async () => {
    // 设定当前为 2026-10-02 11:00 北京时间 (03:00Z)
    vi.setSystemTime(new Date('2026-10-02T03:00:00.000Z'))
    const scheduler = new DailyReportScheduler(mockReports, mockSettings)
    scheduler.start()

    expect(scheduler.nextRun).toEqual({
      day: '2026-10-02',
      time: '12:00',
      timestamp: Date.parse('2026-10-02T12:00:00+08:00'),
    })

    // 快进 1 小时到 12:00
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(mockReports.generate).toHaveBeenCalledWith('2026-10-02', 'append')
    // 触发完成后应自动规划下一次执行 (18:00)
    expect(scheduler.nextRun?.time).toBe('18:00')

    await scheduler.close()
  })

  it('当天没有工作日志时静默跳过，不抛出异常', async () => {
    vi.setSystemTime(new Date('2026-10-02T03:00:00.000Z'))
    mockReports.generate = vi.fn().mockRejectedValue(new DailyReportError('这一天还没有工作日志', 400))

    const scheduler = new DailyReportScheduler(mockReports, mockSettings)
    scheduler.start()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mockReports.generate).toHaveBeenCalled()
    // 依然规划下一个时间点
    expect(scheduler.nextRun?.time).toBe('18:00')

    await scheduler.close()
  })

  it('设置变更时自动重新规划调度', async () => {
    vi.setSystemTime(new Date('2026-10-02T03:00:00.000Z'))
    const scheduler = new DailyReportScheduler(mockReports, mockSettings)
    scheduler.start()

    expect(scheduler.nextRun?.time).toBe('12:00')

    // 用户更新设置为 11:30
    mockSchedule = { enabled: true, times: ['11:30'] }
    listeners.forEach((fn) => fn())

    expect(scheduler.nextRun?.time).toBe('11:30')

    // 用户关闭自动生成日报
    mockSchedule = { enabled: false, times: ['11:30'] }
    listeners.forEach((fn) => fn())

    expect(scheduler.nextRun).toBeNull()

    await scheduler.close()
  })
})
