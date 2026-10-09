import type { ModelRuntimeStatus } from './settings.js'

export interface ModelIdentity { alias?: string; id: string; label: string; name: string }
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
    return entry ? { id: entry.id, label: entry.label, name: entry.name, ...(entry.alias ? { alias: entry.alias } : {}) } : null
  }
  return { next: find(runtime.nextModelId), lastUsed: find(runtime.lastUsedModelId),
    active: (runtime.activeModelIds ?? []).flatMap((id) => { const entry = find(id); return entry ? [entry] : [] }),
    autoSwitch, recovering: runtime.coolingModelIds.length > 0 }
}

// 芯片展示名称独立于真正发给上游的模型 ID。
export function modelChipDisplay(usage?: ModelUsage, legacyName?: string) {
  const model = usage?.active[0] ?? usage?.next
  if (model) return { text: model.alias?.trim() || model.label || model.name, title: model.name }
  return { text: usage ? '模型待就绪' : legacyName || '工作流核心', title: usage ? '暂无可用模型' : legacyName }
}
