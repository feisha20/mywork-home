import { defaultPeriodicReportSchedule, type SettingsUpdate, type WorkbenchSettings } from '../../shared/settings'

export type SettingsTab = 'model' | 'channels' | 'automation'

export function settingsDraft(settings: WorkbenchSettings): SettingsUpdate {
  return { revision: settings.revision, model: { baseUrl: settings.model.baseUrl, name: settings.model.name, apiKey: '', clearApiKey: false },
    sync: { ...settings.sync },
    dailyReportSchedule: { enabled: settings.dailyReportSchedule.enabled, times: [...settings.dailyReportSchedule.times] },
    periodicReportSchedule: settings.periodicReportSchedule
      ? { ...settings.periodicReportSchedule }
      : { ...defaultPeriodicReportSchedule },
    channels: structuredClone(settings.channels) }
}

export function moveChannel<T extends { id: string }>(channels: readonly T[], id: string, targetIndex: number): T[] {
  const index = channels.findIndex((channel) => channel.id === id)
  const result = [...channels]
  if (index < 0 || targetIndex < 0 || targetIndex >= result.length || index === targetIndex) return result
  result.splice(targetIndex, 0, ...result.splice(index, 1))
  return result
}
