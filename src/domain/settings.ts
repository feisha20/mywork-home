import { defaultPeriodicReportSchedule, type SettingsUpdate, type WorkbenchSettings } from '../../shared/settings'
import { defaultZentaoManagement } from '../../shared/zentaoManagement'

export type SettingsTab = 'model' | 'channels' | 'automation' | 'mcp'

export function settingsDraft(settings: WorkbenchSettings): SettingsUpdate {
  const models = (settings.models ?? [{ ...settings.model, id: 'default', label: '默认模型', enabled: true }])
    .map(({ hasApiKey: _key, ...model }) => ({ ...model, apiKey: '', clearApiKey: false }))
  return { models, autoSwitchModels: settings.autoSwitchModels ?? true, revision: settings.revision, model: models[0],
    sync: { ...settings.sync },
    dailyReportSchedule: { enabled: settings.dailyReportSchedule.enabled, times: [...settings.dailyReportSchedule.times] },
    periodicReportSchedule: settings.periodicReportSchedule
      ? { ...settings.periodicReportSchedule }
      : { ...defaultPeriodicReportSchedule },
    channels: settings.channels.map(({ zentao, ...channel }) => ({ ...structuredClone(channel), ...(channel.collector === 'zentao' ? {
      zentao: { baseUrl: zentao?.baseUrl ?? '', account: zentao?.account ?? '', password: '', clearPassword: false,
        management: { ...defaultZentaoManagement, ...zentao?.management } },
    } : {}) })) }
}

export function moveChannel<T extends { id: string }>(channels: readonly T[], id: string, targetIndex: number): T[] {
  const index = channels.findIndex((channel) => channel.id === id)
  const result = [...channels]
  if (index < 0 || targetIndex < 0 || targetIndex >= result.length || index === targetIndex) return result
  result.splice(targetIndex, 0, ...result.splice(index, 1))
  return result
}

// 草稿首选只描述保存后的顺序，不冒充服务端正在使用的模型。
export function draftModelReady(model: NonNullable<SettingsUpdate['models']>[number], saved: WorkbenchSettings) {
  const previous = saved.models?.find((entry) => entry.id === model.id)
  return model.enabled && !!model.baseUrl.trim() && !!model.name.trim() && !model.clearApiKey
    && !!(model.apiKey?.trim() || (previous?.hasApiKey && previous.baseUrl === model.baseUrl.trim().replace(/\/+$/, '')))
}
export function preferredDraftModel(draft: SettingsUpdate, saved: WorkbenchSettings) {
  return draft.models?.find((model) => draftModelReady(model, saved))
}
