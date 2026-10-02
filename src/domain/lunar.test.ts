import { describe, expect, it } from 'vitest'
import { getLunarDate } from './lunar'

describe('万年历农历与节气节假日计算', () => {
  it('正确解析2026年国庆节', () => {
    const info = getLunarDate('2026-10-01')
    expect(info.yearName).toBe('丙午')
    expect(info.zodiac).toBe('马')
    expect(info.solarFestival).toBe('国庆节')
    expect(info.displayTag).toBe('国庆')
    expect(info.tagType).toBe('festival')
    expect(info.fullLunarString).toContain('丙午年【马年】农历八月廿一')
  })

  it('正确解析2026年中秋节（农历八月十五，对应公历2026-09-25）', () => {
    const info = getLunarDate('2026-09-25')
    expect(info.lunarMonthName).toBe('八月')
    expect(info.lunarDayName).toBe('十五')
    expect(info.lunarFestival).toBe('中秋节')
    expect(info.displayTag).toBe('中秋')
    expect(info.tagType).toBe('festival')
  })

  it('正确解析2026年春节与除夕', () => {
    const eve = getLunarDate('2026-02-16')
    expect(eve.lunarFestival).toBe('除夕')
    expect(eve.displayTag).toBe('除夕')

    const spring = getLunarDate('2026-02-17')
    expect(spring.lunarFestival).toBe('春节')
    expect(spring.displayTag).toBe('春节')
    expect(spring.lunarMonthName).toBe('正月')
    expect(spring.lunarDayName).toBe('初一')
  })

  it('正确解析二十四节气', () => {
    const qingming = getLunarDate('2026-04-05')
    expect(qingming.solarTerm).toBe('清明')
    expect(qingming.displayTag).toBe('清明')
    expect(qingming.tagType).toBe('solarTerm')

    const hanlu = getLunarDate('2026-10-08')
    expect(hanlu.solarTerm).toBe('寒露')
    expect(hanlu.displayTag).toBe('寒露')
    expect(hanlu.tagType).toBe('solarTerm')
  })

  it('农历初一显示农历月份名称', () => {
    // 2026-10-10 是农历九月初一
    const day = getLunarDate('2026-10-10')
    expect(day.lunarMonthName).toBe('九月')
    expect(day.lunarDayName).toBe('初一')
    expect(day.solarFestival).toBeNull()
    expect(day.lunarFestival).toBeNull()
    expect(day.displayTag).toBe('九月')
    expect(day.tagType).toBe('lunarMonth')
  })

  it('普通日期显示农历日名称', () => {
    const day = getLunarDate('2026-10-02')
    expect(day.lunarMonthName).toBe('八月')
    expect(day.lunarDayName).toBe('廿二')
    expect(day.displayTag).toBe('廿二')
    expect(day.tagType).toBe('lunarDay')
  })
})
