import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '../../shared/contracts'
import { channelSlots, channelStatus } from './channelDock'
import { CAPTURE_SOURCES } from './workbench'

const sources: WorkbenchSnapshot['sources'] = {
  codex: { available: true, sessionCount: 63, error: null },
  claude: { available: true, sessionCount: 14, error: null },
  workbuddy: { available: true, sessionCount: 17, error: null },
  zcode: { available: true, sessionCount: 4, error: null },
}
describe('渠道入口与采集状态', () => {
  it('当前五个渠道完整展示，渠道增长后仍最多五个入口且不遗漏来源', () => {
    const current = channelSlots(CAPTURE_SOURCES)
    expect(current).toHaveLength(5)
    expect(current.every((slot) => !slot.overflow)).toBe(true)
    const expanded = [...CAPTURE_SOURCES, '新增渠道一', '新增渠道二', '新增渠道三']
    const slots = channelSlots(expanded)
    expect(slots).toHaveLength(5)
    expect(slots.at(-1)?.overflow).toBe(true)
    expect(slots.at(-1)?.sources).toEqual(['zcode', '新增渠道一', '新增渠道二', '新增渠道三'])
    expect(slots.flatMap((slot) => slot.sources)).toEqual(expanded)
  })
  it('更多入口保留隐藏采集源的关联，可高亮活动来源与实际引脚', () => {
    const slots = channelSlots([...CAPTURE_SOURCES, '新增渠道'])
    expect(slots.filter((slot) => slot.sources.includes('zcode')).map((slot) => slot.id)).toEqual(['more'])
    expect(channelSlots([])).toEqual([])
  })
  it('会话数为零仍显示已接入，待接入和初次扫描不伪装成异常', () => {
    expect(channelStatus('zcode', { ...sources, zcode: { available: true, sessionCount: 0, error: null } }, null)).toMatchObject({ kind: 'connected', sessionCount: 0 })
    expect(channelStatus('zentao', sources, null)).toMatchObject({ kind: 'pending', label: '待接入', sessionCount: null })
    expect(channelStatus('claude', undefined, null)).toMatchObject({ kind: 'pending', label: '等待扫描' })
    expect(channelStatus('claude', { ...sources, claude: { available: false, sessionCount: 0, error: '尚未扫描' } }, null)).toMatchObject({ kind: 'pending' })
  })
  it('读取异常只标记对应渠道，当前活动来源优先显示采集中', () => {
    const errors = ['codex：部分记录读取失败，下次同步重试', 'codex：跳过 1 条超大记录']
    expect(channelStatus('codex', sources, null, errors)).toMatchObject({ kind: 'warning', label: '部分待重试', sessionCount: 63 })
    expect(channelStatus('zcode', sources, null, errors)).toMatchObject({ kind: 'connected' })
    expect(channelStatus('codex', sources, 'codex', errors)).toMatchObject({ kind: 'active' })
    expect(channelStatus('zcode', { ...sources, zcode: { available: false, sessionCount: 0, error: '数据库无法读取' } }, null)).toMatchObject({ kind: 'warning', label: '读取异常', detail: '数据库无法读取' })
  })
})
