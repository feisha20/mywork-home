import type { WorkbenchSnapshot } from '../../shared/contracts'
import type { SourceId } from './workbench'

export type CaptureSource = Exclude<SourceId, 'manual'>
export interface ChannelSlot<T extends string = CaptureSource> { id: string; sources: T[]; overflow: boolean }
export type ChannelStatusKind = 'connected' | 'active' | 'pending' | 'warning'

// 渠道增加时只扩充详情列表；主面板始终保持一排、最多五个入口。
export function channelSlots<T extends string>(sources: readonly T[], capacity = 5): ChannelSlot<T>[] {
  const limit = Math.max(2, Math.floor(capacity))
  const visible = sources.length > limit ? sources.slice(0, limit - 1) : sources
  const slots: ChannelSlot<T>[] = visible.map((source) => ({ id: source, sources: [source], overflow: false }))
  if (sources.length > limit) slots.push({ id: 'more', sources: sources.slice(limit - 1), overflow: true })
  return slots
}

export function channelStatus(source: CaptureSource, sources: WorkbenchSnapshot['sources'] | undefined,
  activeSource: CaptureSource | null, errors: readonly string[] = []): { kind: ChannelStatusKind; label: string; detail: string; sessionCount: number | null } {
  if (source === 'zentao') return { kind: 'pending', label: '待接入', detail: '禅道任务采集尚未接入', sessionCount: null }
  const state = sources?.[source]
  const sessionCount = state?.sessionCount ?? 0
  if (source === activeSource) return { kind: 'active', label: '采集中', detail: `${sessionCount} 个会话 · 正在采集`, sessionCount }
  const sourceErrors = errors.filter((error) => error.toLowerCase().startsWith(`${source}：`) || error.toLowerCase().startsWith(`${source}:`))
  if (sourceErrors.length || (state?.error && state.error !== '尚未扫描')) {
    return { kind: 'warning', label: state?.available ? '部分待重试' : '读取异常', detail: state?.error || `${sessionCount} 个会话 · ${sourceErrors.length} 条采集提示`, sessionCount }
  }
  if (state?.available) return { kind: 'connected', label: '已接入', detail: `${sessionCount} 个会话 · 已接入`, sessionCount }
  return { kind: 'pending', label: '等待扫描', detail: '首次扫描后显示会话数量', sessionCount: null }
}
