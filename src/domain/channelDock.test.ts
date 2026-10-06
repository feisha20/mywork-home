import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '../../shared/contracts'
import { channelSlots, channelStatus } from './channelDock'
import { CAPTURE_SOURCES } from './workbench'

const sources: WorkbenchSnapshot['sources'] = {
  codex: { available: true, sessionCount: 63, error: null },
  claude: { available: true, sessionCount: 14, error: null },
  workbuddy: { available: true, sessionCount: 17, error: null },
  zcode: { available: true, sessionCount: 4, error: null },
  gemini: { available: true, sessionCount: 14, error: null },
}
describe('渠道入口与采集状态', () => {
  it('六个渠道保持五个入口，Gemini 和 Zcode 收进更多且不遗漏来源', () => {
    const current = channelSlots(CAPTURE_SOURCES)
    expect(current).toHaveLength(5)
    expect(current.at(-1)).toEqual({ id: 'more', sources: ['zcode', 'gemini'], overflow: true })
    expect(current.flatMap((slot) => slot.sources)).toEqual(CAPTURE_SOURCES)
    const expanded = [...CAPTURE_SOURCES, '新增渠道一', '新增渠道二', '新增渠道三']
    const slots = channelSlots(expanded)
    expect(slots).toHaveLength(5)
    expect(slots.at(-1)?.overflow).toBe(true)
    expect(slots.at(-1)?.sources).toEqual(['zcode', 'gemini', '新增渠道一', '新增渠道二', '新增渠道三'])
    expect(slots.flatMap((slot) => slot.sources)).toEqual(expanded)
  })
  it('更多入口保留隐藏采集源的关联，可高亮活动来源与实际引脚', () => {
    const slots = channelSlots([...CAPTURE_SOURCES, '新增渠道'])
    expect(slots.filter((slot) => slot.sources.includes('zcode')).map((slot) => slot.id)).toEqual(['more'])
    expect(slots.filter((slot) => slot.sources.includes('gemini')).map((slot) => slot.id)).toEqual(['more'])
    expect(channelStatus('gemini', sources, 'gemini')).toMatchObject({ kind: 'active', sessionCount: 14 })
    expect(channelSlots([])).toEqual([])
  })
  it('会话数为零仍显示已接入，待接入和初次扫描不伪装成异常', () => {
    expect(channelStatus('zcode', { ...sources, zcode: { available: true, sessionCount: 0, error: null } }, null)).toMatchObject({ kind: 'connected', sessionCount: 0 })
    expect(channelStatus('zentao', sources, null)).toMatchObject({ kind: 'pending', label: '等待连接', sessionCount: null })
    expect(channelStatus('claude', undefined, null)).toMatchObject({ kind: 'pending', label: '等待扫描' })
    expect(channelStatus('claude', { ...sources, claude: { available: false, sessionCount: 0, error: '尚未扫描' } }, null)).toMatchObject({ kind: 'pending' })
  })
  it('禅道接入和活动状态按待办数量展示，包括没有待办的正常连接', () => {
    const connected = { ...sources, zentao: { available: true, sessionCount: 3, error: null, collector: 'zentao' } }
    expect(channelStatus('zentao', connected, null)).toMatchObject({ kind: 'connected', detail: '3 条待办 · 已接入' })
    expect(channelStatus('zentao', connected, 'zentao')).toMatchObject({ kind: 'active', detail: '3 条待办 · 正在采集' })
    expect(channelStatus('zentao', { ...sources, zentao: { available: true, sessionCount: 0, error: null } }, null).kind).toBe('connected')
    expect(channelStatus('zentao', connected, null, ['zentao：认证失败']).kind).toBe('warning')
  })
  it('读取异常只标记对应渠道，当前活动来源优先显示采集中', () => {
    const errors = ['codex：部分记录读取失败，下次同步重试', 'codex：跳过 1 条超大记录']
    expect(channelStatus('codex', sources, null, errors)).toMatchObject({ kind: 'warning', label: '部分待重试', sessionCount: 63 })
    expect(channelStatus('zcode', sources, null, errors)).toMatchObject({ kind: 'connected' })
    expect(channelStatus('codex', sources, 'codex', errors)).toMatchObject({ kind: 'active' })
    expect(channelStatus('zcode', { ...sources, zcode: { available: false, sessionCount: 0, error: '数据库无法读取' } }, null)).toMatchObject({ kind: 'warning', label: '读取异常', detail: '数据库无法读取' })
  })
})
