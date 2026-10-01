import { describe, expect, it } from 'vitest'
import { calendarDays, shiftMonth } from './calendar'

describe('日志日历日期', () => {
  it('按周一开始并补齐六周，覆盖跨月日期', () => {
    const days = calendarDays('2026-10')
    expect(days).toHaveLength(42)
    expect(days[0]).toBe('2026-09-28')
    expect(days.at(-1)).toBe('2026-11-08')
    expect(new Set(days).size).toBe(42)
  })
  it('跨年切换月份和闰年二月正确', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(calendarDays('2024-02')).toContain('2024-02-29')
    expect(calendarDays('2026-02')).not.toContain('2026-02-29')
  })
})
