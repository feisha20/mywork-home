import { describe, expect, it } from 'vitest'
import { moveChannel, settingsDraft } from './settings'
import { channelSlots, channelStatus } from './channelDock'
import { decodeSnapshot, recordTimestamp, sourceInfo } from './workbench'
import type { WorkbenchSettings } from '../../shared/settings'

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
  it('settingsDraft 完整拷贝自动采集与定时日报配置', () => {
    const settings: WorkbenchSettings = {
      revision: 2,
      model: { baseUrl: 'https://example.com', name: 'test-model', hasApiKey: true },
      sync: { enabled: true, intervalMs: 300_000 },
      dailyReportSchedule: { enabled: true, times: ['12:00', '18:00', '21:00'] },
      periodicReportSchedule: { weeklyEnabled: true, weeklyDay: 5, weeklyTime: '18:00', monthlyEnabled: true, monthlyTime: '18:00' },
      channels: [],
      pathEnvironment: 'local',
    }
    const draft = settingsDraft(settings)
    expect(draft.dailyReportSchedule).toEqual({ enabled: true, times: ['12:00', '18:00', '21:00'] })
    expect(draft.periodicReportSchedule).toEqual({ weeklyEnabled: true, weeklyDay: 5, weeklyTime: '18:00', monthlyEnabled: true, monthlyTime: '18:00' })
    // 修改 draft 不影响原始配置
    draft.dailyReportSchedule.times.push('23:00')
    expect(settings.dailyReportSchedule.times).toHaveLength(3)
  })
})
