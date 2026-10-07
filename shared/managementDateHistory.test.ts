import { describe, expect, it } from 'vitest'
import { normalizeManagementDateHistory, sameReleaseDates, updateManagementDateHistory } from './managementDateHistory.js'
import type { EffectiveDate, ReleaseDates } from './zentaoManagement.js'

const date: EffectiveDate = { state: 'empty', value: null, day: null, timestamp: null,
  precision: 'day', source: 'story', sourceLabel: '需求字段', fieldPath: '计划上线时间' }
const dates: ReleaseDates = { planned: date, actual: { ...date, fieldPath: '实际上线时间' }, fallbackExecutionId: null }
const changed: ReleaseDates = { ...dates, planned: { ...date, state: 'invalid', value: '待核对日期' } }
const entry = (value: ReleaseDates, at = '2026-10-07T05:00:00Z') => ({ at, dates: value })

describe('管理日期依据历史', () => {
  it('忽略 JSONB 往返后的对象字段顺序，重复核实不追加历史', () => {
    const reorder = (value: object): any => Object.fromEntries(Object.entries(value).reverse()
      .map(([key, child]) => [key, child && typeof child === 'object' ? reorder(child) : child]))
    const stored = reorder(dates) as ReleaseDates
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(dates))
    expect(sameReleaseDates(stored, dates)).toBe(true)
    expect(updateManagementDateHistory([], stored, dates, entry(dates).at)).toEqual([])
  })

  it('记录真实日期、来源字段及回退冲刺的变化', () => {
    for (const next of [changed, { ...dates, planned: { ...date, fieldPath: '新的字段' } },
      { ...dates, fallbackExecutionId: '11' }, { ...dates, actual: { ...date, source: 'execution' as const } }]) {
      expect(updateManagementDateHistory([], dates, next, entry(dates).at)).toEqual([entry(dates)])
    }
  })

  it('清理与当前依据相同的连续重复旧记录，不修改输入', () => {
    const history = [entry(dates), entry(dates)]
    expect(updateManagementDateHistory(history, dates, dates, entry(dates).at)).toEqual([])
    expect(history).toHaveLength(2)
    expect(normalizeManagementDateHistory(history, dates)).toEqual([])
  })

  it('合并连续重复项，保留往返变更及最后一次真实变化时间', () => {
    const history = [entry(dates, '1'), entry(dates, '2'), entry(changed, '3'), entry(changed, '4')]
    expect(normalizeManagementDateHistory(history, dates)).toEqual([entry(dates, '2'), entry(changed, '4')])
  })

  it('首次采集不产生历史，无当前日期时保留已有依据', () => {
    expect(updateManagementDateHistory(undefined, undefined, dates, entry(dates).at)).toEqual([])
    expect(normalizeManagementDateHistory([entry(dates)])).toEqual([entry(dates)])
  })
})
