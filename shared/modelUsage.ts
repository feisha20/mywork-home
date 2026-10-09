import type { ModelRuntimeStatus } from './settings.js'

export interface ModelIdentity { id: string; label: string; name: string }
export interface ModelUsage {
  next: ModelIdentity | null
  lastUsed: ModelIdentity | null
  active: ModelIdentity[]
  autoSwitch: boolean
  recovering: boolean
}

// 只传递展示信息，不携带密钥、基础地址或本机路径。
export function modelUsage(models: readonly ModelIdentity[], runtime: ModelRuntimeStatus, autoSwitch: boolean): ModelUsage {
  const find = (id: string | null) => {
    const entry = models.find((model) => model.id === id)
    return entry ? { id: entry.id, label: entry.label, name: entry.name } : null
  }
  return { next: find(runtime.nextModelId), lastUsed: find(runtime.lastUsedModelId),
    active: (runtime.activeModelIds ?? []).flatMap((id) => { const entry = find(id); return entry ? [entry] : [] }),
    autoSwitch, recovering: runtime.coolingModelIds.length > 0 }
}
