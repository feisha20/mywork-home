import { describe, expect, it } from 'vitest'
import { moveChannel } from './settings'
import { channelSlots, channelStatus } from './channelDock'
import { decodeSnapshot, recordTimestamp, sourceInfo } from './workbench'

describe('可配置渠道显示', () => {
  it('拖动与上下移动统一保留来源顺序，更多入口保留完整列表', () => {
    const channels = ['codex', 'claude', 'workbuddy', 'zentao', 'zcode', 'gemini', 'custom-editor'].map((id) => ({ id }))
    const ordered = moveChannel(channels, 'custom-editor', 0)
    expect(ordered.map((channel) => channel.id)).toEqual(['custom-editor', 'codex', 'claude', 'workbuddy', 'zentao', 'zcode', 'gemini'])
    expect(channelSlots(ordered.map((channel) => channel.id)).flatMap((slot) => slot.sources)).toEqual(ordered.map((channel) => channel.id))
    expect(channels[0].id).toBe('codex')
    expect(moveChannel(ordered, 'custom-editor', -1)).toEqual(ordered)
  })
  it('自定义来源日志可读取并按原始日期归档，停用渠道显示真实状态', () => {
    const task = { id: 'custom-task', reference: 'CH-1', source: 'custom-editor' as const, title: '完善新渠道采集', createdAt: '2026-10-01T01:00:00Z', completedAt: null }
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [task] }))?.tasks).toEqual([task])
    expect(recordTimestamp(task)).toBe(task.createdAt)
    expect(sourceInfo('custom-editor', [{ id: 'custom-editor', name: '新编辑器', logo: '', collector: 'codex', enabled: true }]).label).toBe('新编辑器')
    expect(channelStatus('codex', { codex: { available: true, sessionCount: 2, error: null, enabled: false } } as never, 'codex')).toMatchObject({ kind: 'pending', label: '已停用' })
  })
})
