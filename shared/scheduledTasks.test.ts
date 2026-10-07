import { describe, expect, it } from 'vitest'
import { nextOccurrence, scheduledTaskSchema, scheduleDescription, type ScheduledTaskInput } from './scheduledTasks'

const base: ScheduledTaskInput = { title: '提交报告', frequency: 'daily', time: '09:00', weekday: 5, day: 31, month: 2, quarterMonth: 1, startDate: '2026-01-01', endDate: null, enabled: true, isPersonal: false }
const next = (from: string, patch: Partial<ScheduledTaskInput> = {}) => nextOccurrence({ ...base, ...patch }, new Date(from))
describe('计划任务日历规则', () => {
  it('北京时间跨日、恰好到期和到期后一毫秒', () => {
    expect(next('2026-10-07T00:59:59Z')).toBe('2026-10-07T01:00:00.000Z')
    expect(next('2026-10-07T01:00:00Z')).toBe('2026-10-07T01:00:00.000Z')
    expect(next('2026-10-07T01:00:00.001Z')).toBe('2026-10-08T01:00:00.000Z')
    expect(next('2026-10-07T16:01:00Z', { time: '00:30' })).toBe('2026-10-07T16:30:00.000Z')
  })
  it('工作日跳过周末，每周可选择周日', () => {
    expect(next('2026-10-09T02:00:00Z', { frequency: 'weekdays' })).toBe('2026-10-12T01:00:00.000Z')
    expect(next('2026-10-09T02:00:00Z', { frequency: 'weekly', weekday: 7 })).toBe('2026-10-11T01:00:00.000Z')
  })
  it('月末适配短月及闰年，每年也遵循月末规则', () => {
    expect(next('2026-02-01T00:00:00Z', { frequency: 'monthly' })).toBe('2026-02-28T01:00:00.000Z')
    expect(next('2028-02-01T00:00:00Z', { frequency: 'monthly' })).toBe('2028-02-29T01:00:00.000Z')
    expect(next('2026-03-01T00:00:00Z', { frequency: 'yearly' })).toBe('2027-02-28T01:00:00.000Z')
  })
  it('季度按季度内月份安排并能跨年', () => {
    expect(next('2026-10-02T00:00:00Z', { frequency: 'quarterly', day: 1 })).toBe('2027-01-01T01:00:00.000Z')
    expect(next('2026-10-02T00:00:00Z', { frequency: 'quarterly', quarterMonth: 3 })).toBe('2026-12-31T01:00:00.000Z')
  })
  it('开始日期、包含结束当天、结束和暂停', () => {
    expect(next('2026-10-01T00:00:00Z', { startDate: '2026-11-01' })).toBe('2026-11-01T01:00:00.000Z')
    expect(next('2026-10-07T00:00:00Z', { endDate: '2026-10-07' })).toBe('2026-10-07T01:00:00.000Z')
    expect(next('2026-10-07T02:00:00Z', { endDate: '2026-10-07' })).toBeNull()
    expect(next('2026-10-07T00:00:00Z', { enabled: false })).toBeNull()
  })
  it('拒绝错误日期、时间、周期和区间，说明与规则一致', () => {
    for (const patch of [{ time: '24:00' }, { weekday: 0 }, { day: 32 }, { startDate: '2026-02-30' }, { endDate: '2025-12-31' }, { extra: true }]) {
      expect(scheduledTaskSchema.safeParse({ ...base, ...patch }).success).toBe(false)
    }
    expect(scheduleDescription({ ...base, frequency: 'quarterly', quarterMonth: 2, day: 1 })).toBe('每季度第 2 个月 1 日 09:00')
  })
})
