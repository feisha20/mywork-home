import { useEffect, useState } from 'react'
import { modelUsage, type ModelUsage } from '../../shared/modelUsage'
import { fetchSettings } from '../data/apiRepository'
import { Icon } from './Icon'

export function ModelStatus({ usage, legacyModel, live = false, compact = false, onOpenSettings }: {
  usage?: ModelUsage; legacyModel?: string; live?: boolean; compact?: boolean; onOpenSettings?: () => void
}) {
  const [current, setCurrent] = useState<ModelUsage>()
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    if (!live) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        if (!document.hidden) {
          const settings = await fetchSettings(controller.signal)
          if (!controller.signal.aborted) {
            setCurrent(modelUsage(settings.models ?? [{ id: 'default', label: '默认模型', name: settings.model.name }],
              settings.modelRuntime ?? { nextModelId: settings.model.hasApiKey ? 'default' : null, preferredModelId: null, lastUsedModelId: null, coolingModelIds: [] }, settings.autoSwitchModels ?? true))
            setUnavailable(false)
          }
        }
      } catch { if (!controller.signal.aborted) setUnavailable(true) }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000) }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [live])
  const value = live ? current : usage
  const fallbackName = value ? undefined : legacyModel
  const active = value?.active ?? []
  const model = active[0] ?? value?.next
  const state = unavailable ? '状态暂不可用' : active.length ? '正在调用' : model || fallbackName ? '下次优先' : value ? '暂无可用模型' : '读取模型状态…'
  if (compact) {
    const name = model?.name ?? fallbackName
    const detail = [state, model ? `${model.label} · ${model.name}` : name,
      value?.lastUsed ? `最近成功：${value.lastUsed.label} · ${value.lastUsed.name}` : '',
      value?.recovering ? '部分模型等待恢复' : '', '显示实时调用状态，不代表已保存日报的生成模型'].filter(Boolean).join('\n')
    return <span className={`model-status-inline${unavailable || (value && !model) ? ' is-unavailable' : ''}`} title={detail} aria-label={detail}>
      <Icon name="model" /><span className="model-status-inline-name">{name ?? state}</span>{name && <small>{state}</small>}
    </span>
  }
  return <section className={`model-status${active.length ? ' is-active' : ''}${value && !model ? ' is-unavailable' : ''}`} aria-label="模型使用状态">
    <div className="model-status-heading"><span><Icon name="model" />工作流模型</span><span className="model-status-state"><i aria-hidden="true" />{state}</span></div>
    <div className="model-status-identity"><strong title={model?.label}>{model?.label ?? (fallbackName ? '默认模型' : '等待模型就绪')}</strong>{onOpenSettings && <button type="button" onClick={onOpenSettings} aria-label="打开模型配置" title="管理模型配置"><Icon name="settings" /></button>}</div>
    <p className="model-status-name">{model?.name ?? fallbackName ?? '请检查模型配置与连接状态'}</p>
    {active.length > 1 && <p className="model-status-detail">同时调用：{active.slice(1).map((entry) => entry.label).join('、')}</p>}
    {value?.lastUsed && <p className="model-status-detail">最近成功<span title={`${value.lastUsed.label} · ${value.lastUsed.name}`}>{value.lastUsed.label} · {value.lastUsed.name}</span></p>}
    {value && <div className="model-status-policy"><span>{value.autoSwitch ? '连接失败自动切换' : '固定使用首选模型'}</span>{value.recovering && <span className="model-status-recovering">部分模型等待恢复</span>}</div>}
    {live && <p className="model-status-note">实时调用状态，非这份已保存日报的生成模型记录。</p>}
  </section>
}
