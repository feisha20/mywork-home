import { describe, expect, it } from 'vitest'
import {
  dailyReportScheduleSchema,
  defaultDailyReportSchedule,
  defaultPeriodicReportSchedule,
  periodicReportScheduleSchema,
  timePointSchema,
} from './settings.js'

describe('自动生成日报设置校验', () => {
  it('正确校验 HH:mm 时间点格式', () => {
    expect(timePointSchema.safeParse('12:00').success).toBe(true)
    expect(timePointSchema.safeParse('00:00').success).toBe(true)
    expect(timePointSchema.safeParse('23:59').success).toBe(true)
    expect(timePointSchema.safeParse('18:30').success).toBe(true)

    expect(timePointSchema.safeParse('24:00').success).toBe(false)
    expect(timePointSchema.safeParse('12:60').success).toBe(false)
    expect(timePointSchema.safeParse('8:00').success).toBe(false)
    expect(timePointSchema.safeParse('12:0').success).toBe(false)
    expect(timePointSchema.safeParse('abc').success).toBe(false)
  })

  it('自动对时间点去重并按升序排列', () => {
    const parsed = dailyReportScheduleSchema.parse({
      enabled: true,
      times: ['21:00', '12:00', '18:00', '12:00'],
    })
    expect(parsed).toEqual({
      enabled: true,
      times: ['12:00', '18:00', '21:00'],
    })
  })

  it('超出 24 个时间点时校验失败', () => {
    const times = Array.from({ length: 25 }, (_, i) => `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`)
    expect(dailyReportScheduleSchema.safeParse({ enabled: true, times }).success).toBe(false)
  })

  it('提供合理的默认时间点配置', () => {
    expect(defaultDailyReportSchedule).toEqual({
      enabled: false,
      times: ['12:00', '18:00', '21:00'],
    })
  })

  it('正确校验并提供默认的周报月报定时配置', () => {
    expect(defaultPeriodicReportSchedule).toEqual({
      weeklyEnabled: true,
      weeklyDay: 5,
      weeklyTime: '18:00',
      monthlyEnabled: true,
      monthlyTime: '18:00',
    })

    const parsed = periodicReportScheduleSchema.parse({
      weeklyEnabled: true,
      weeklyDay: 7,
      weeklyTime: '20:00',
      monthlyEnabled: false,
      monthlyTime: '19:30',
    })
    expect(parsed.weeklyDay).toBe(7)
    expect(parsed.weeklyTime).toBe('20:00')

    expect(periodicReportScheduleSchema.safeParse({
      weeklyEnabled: true,
      weeklyDay: 0, // 应当 1-7
      weeklyTime: '18:00',
      monthlyEnabled: true,
      monthlyTime: '18:00',
    }).success).toBe(false)
  })
})
