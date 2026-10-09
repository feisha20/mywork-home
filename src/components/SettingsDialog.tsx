import { modelApiFormat, modelApiHelp, modelApiOptions } from '../../shared/modelApi'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { COLLECTORS, EMPTY_ZENTAO_SETTINGS, settingsUpdateSchema } from '../../shared/settings'
import type { ChannelId, CollectorKind, ModelRuntimeStatus, SettingsUpdate, WorkbenchSettings } from '../../shared/settings'
import { fetchSettings, saveSettings, scanChannelPaths, testModelConnection, testZentaoConnection, inspectZentaoFields } from '../data/apiRepository'
import { channelSlots } from '../domain/channelDock'
import { moveChannel, draftModelReady, preferredDraftModel, settingsDraft, type SettingsTab } from '../domain/settings'
import { sourceInfo } from '../domain/workbench'
import { ChannelLogo } from './ChannelLogo'
import { Icon } from './Icon'
import { SourcePathDetails } from './SourcePathDetails'
import { SettingsSelect } from './SettingsSelect'
import { RecordCompatibility } from './RecordCompatibility'
import { McpSettings } from './McpSettings'
import { defaultZentaoManagement, type ManagementFieldPreview, type ZentaoManagementSettings } from '../../shared/zentaoManagement'

type DraftChannel = SettingsUpdate['channels'][number]
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试'
const collectorOptions = Object.entries(COLLECTORS).map(([value, label]) => ({ value: value as CollectorKind, label }))
const compatibleOptions = collectorOptions.filter((option) => ['auto', 'generic', 'none'].includes(option.value))

interface SettingsDialogProps {
  onClose: () => void
  onSaved: (settings: WorkbenchSettings) => void
  notificationsEnabled: boolean
  requestingNotifications: boolean
  notificationDescription: string
  onToggleNotifications: () => void
}

export function SettingsDialog({ onClose, onSaved, notificationsEnabled, requestingNotifications,
  notificationDescription, onToggleNotifications }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [saved, setSaved] = useState<WorkbenchSettings | null>(null)
  const [draft, setDraft] = useState<SettingsUpdate | null>(null)
  const [tab, setTab] = useState<SettingsTab>('model')
  const [newTime, setNewTime] = useState('18:00')
  const [selectedId, setSelectedId] = useState<string>('codex')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [scanning, setScanning] = useState<string | null>(null)
  const [modelRuntime, setModelRuntime] = useState<ModelRuntimeStatus | undefined>()
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null)
  const [selectedModelId, setSelectedModelId] = useState('default')
  const [showKey, setShowKey] = useState(false)
  const [showZentaoPassword, setShowZentaoPassword] = useState(false)
  const [fieldPreview, setFieldPreview] = useState<ManagementFieldPreview | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [modelTestResult, setModelTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null)
  const [scanFeedback, setScanFeedback] = useState<{ id: string; message: string } | null>(null)
  const [scanChoices, setScanChoices] = useState<{ id: string; paths: string[] } | null>(null)
  const [unresolvedPaths, setUnresolvedPaths] = useState<string[]>([])
  const [pathCheckVersion, setPathCheckVersion] = useState(0)
  const [discarding, setDiscarding] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const busy = saving || testing || scanning !== null || mcpBusy
  const dirty = !!saved && !!draft && JSON.stringify(settingsDraft(saved)) !== JSON.stringify(draft)
  const model = draft?.models?.find((entry) => entry.id === selectedModelId) ?? draft?.models?.[0]
  const modelSaved = saved?.models?.find((entry) => entry.id === model?.id)
  const modelHasSavedKey = !!modelSaved?.hasApiKey && modelSaved.baseUrl === model?.baseUrl.replace(/\/+$/, '') && modelApiFormat(modelSaved.apiFormat) === modelApiFormat(model?.apiFormat)
  const draftPreferred = draft && saved ? preferredDraftModel(draft, saved) : undefined
  const otherEnabledModels = draft?.models?.filter((entry) => entry.id !== model?.id && entry.enabled).length ?? 0
  const canRemoveModel = (draft?.models?.length ?? 0) > 1 && (!model?.enabled || otherEnabledModels > 0)
  const modelDirty = !!draft && !!saved && JSON.stringify([draft.models, draft.autoSwitchModels]) !== JSON.stringify([settingsDraft(saved).models, saved.autoSwitchModels ?? true])
  const channel = draft?.channels.find((entry) => entry.id === selectedId)
  const channelSaved = saved?.channels.find((entry) => entry.id === selectedId)
  const collectorLocked = !!channelSaved && (!channelSaved.id.startsWith('custom-') || !['none', 'auto', 'generic'].includes(channelSaved.collector))
  const compatibleCollector = channel?.collector === 'auto' || channel?.collector === 'generic'
  const pathNamesUnavailable = channel?.paths.some((path) => unresolvedPaths.includes(path)) ?? false

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(null)
    void fetchSettings(controller.signal).then((settings) => {
      setModelRuntime(settings.modelRuntime); setSaved(settings); setDraft(settingsDraft(settings)); setUnresolvedPaths(settings.unresolvedPaths ?? [])
    }).catch((cause) => { if (!controller.signal.aborted) setError(messageOf(cause)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [loadVersion])

  useEffect(() => {
    if (tab !== 'model' || loading) return
    const controller = new AbortController()
    const refresh = () => { void fetchSettings(controller.signal).then((settings) => setModelRuntime(settings.modelRuntime)).catch(() => {}) }
    const timer = window.setInterval(refresh, 10_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [tab, loading])

  function requestClose() {
    if (busy) return
    if (dirty) { setDiscarding(true); return }
    onClose()
  }
  function changeModels(models: NonNullable<SettingsUpdate['models']>) {
    setDraft((current) => current && { ...current, models, model: models[0] }); setFeedback(null); setModelTestResult(null); setDeletingModelId(null)
  }
  function changeModel(patch: Partial<NonNullable<SettingsUpdate['models']>[number]>) {
    if (draft?.models && model) changeModels(draft.models.map((entry) => entry.id === model.id ? { ...entry, ...patch } : entry))
  }
  function addModel() {
    if (!draft?.models) return
    const id = crypto.randomUUID()
    changeModels([...draft.models, { id, apiFormat: 'openai-completions', label: '新模型', enabled: true, baseUrl: '', name: '', apiKey: '', clearApiKey: false }])
    setSelectedModelId(id); setShowKey(false)
  }
  function changeChannel(id: string, patch: Partial<DraftChannel>) {
    setDraft((current) => current && { ...current, channels: current.channels.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) }); setFeedback(null)
  }
  function reorder(id: string, index: number) {
    setDraft((current) => current && { ...current, channels: moveChannel(current.channels, id, index) }); setFeedback(null)
  }
  function addChannel() {
    const id = `custom-${crypto.randomUUID()}`
    setDraft((current) => current && { ...current, channels: [...current.channels, { id, name: '新渠道', logo: '', collector: 'auto', enabled: true, pathMode: 'scan', paths: [] }] })
    setSelectedId(id); setFeedback(null)
  }
  function addTime(timeToAdd = newTime) {
    if (!draft) return
    const time = timeToAdd.trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return
    if (draft.dailyReportSchedule.times.includes(time)) return
    if (draft.dailyReportSchedule.times.length >= 24) return
    const nextTimes = [...new Set([...draft.dailyReportSchedule.times, time])].sort()
    setDraft((current) => current && {
      ...current,
      dailyReportSchedule: { ...current.dailyReportSchedule, times: nextTimes },
    })
    setFeedback(null)
  }
  function removeTime(timeToRemove: string) {
    if (!draft) return
    const nextTimes = draft.dailyReportSchedule.times.filter((time) => time !== timeToRemove)
    setDraft((current) => current && {
      ...current,
      dailyReportSchedule: { ...current.dailyReportSchedule, times: nextTimes },
    })
    setFeedback(null)
  }
  async function handleSave(event: FormEvent) {
    event.preventDefault()
    if (!draft || busy || tab === 'mcp') return
    setError(null); setFeedback(null); setModelTestResult(null); setDiscarding(false)
    const parsed = settingsUpdateSchema.safeParse({ ...draft, channels: draft.channels.map((entry) => ({ ...entry, paths: entry.paths.map((path) => path.trim()).filter(Boolean) })) })
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => issue.message).join('；')); return }
    setSaving(true)
    try {
      const result = await saveSettings(parsed.data)
      setModelRuntime(result.modelRuntime); setDeletingModelId(null); setSaved(result); setDraft(settingsDraft(result)); setShowKey(false); setShowZentaoPassword(false); setUnresolvedPaths(result.unresolvedPaths ?? [])
      setFeedback('设置已保存，下次采集和模型请求使用新配置。'); onSaved(result)
    } catch (cause) { setError(messageOf(cause)) }
    finally { setSaving(false) }
  }
  async function handleScan(channel: DraftChannel) {
    if (busy) return
    setScanning(channel.id); setError(null); setScanFeedback(null)
    try {
      const universal = channel.collector === 'auto' || channel.collector === 'generic'
      const result = await scanChannelPaths(channel.collector, universal ? channel.paths.map((path) => path.trim()).filter(Boolean) : [])
      if (universal) setScanChoices({ id: channel.id, paths: result.paths.filter((path) => !result.unresolvedPaths?.includes(path)) })
      else if (result.paths.length) changeChannel(channel.id, { paths: result.paths, pathMode: 'scan' })
      setUnresolvedPaths((current) => [...new Set([...current, ...(result.unresolvedPaths ?? [])])])
      setPathCheckVersion((current) => current + 1)
      setScanFeedback({ id: channel.id, message: result.message })
    } catch (cause) { setError(messageOf(cause)) }
    finally { setScanning(null) }
  }
  async function handleTest() {
    if (!model || busy) return
    setTesting(true); setError(null); setFeedback(null); setModelTestResult(null)
    try { setModelTestResult({ id: model.id, success: true, message: (await testModelConnection(model)).message }) }
    catch (cause) { setModelTestResult({ id: model.id, success: false, message: messageOf(cause) }) }
    finally { setTesting(false) }
  }
  function changeZentao(patch: Partial<NonNullable<DraftChannel['zentao']>>) {
    setFieldPreview(null)
    if (channel) changeChannel(channel.id, { zentao: { ...EMPTY_ZENTAO_SETTINGS, ...channel.zentao, ...patch } })
  }
  function changeManagement(patch: Partial<ZentaoManagementSettings>) {
    changeZentao({ management: { ...defaultZentaoManagement, ...channel?.zentao?.management, ...patch } })
  }
  async function handleInspectFields() {
    if (!channel?.zentao || busy) return
    setTesting(true); setError(null); setFieldPreview(null)
    try { setFieldPreview(await inspectZentaoFields(channel.zentao)) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setTesting(false) }
  }
  async function handleTestZentao() {
    if (!channel?.zentao || busy) return
    setTesting(true); setError(null); setFeedback(null)
    try { setFeedback((await testZentaoConnection(channel.zentao)).message) }
    catch (cause) { setError(messageOf(cause)) }
    finally { setTesting(false) }
  }
  async function uploadLogo(file: File | undefined) {
    if (!file || !channel) return
    setError(null)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 256 * 1024) {
      setError('请选择不超过 256 KB 的 PNG、JPEG 或 WebP 图片'); return
    }
    const id = channel.id
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败，请重新选择'))
        reader.readAsDataURL(file)
      })
      changeChannel(id, { logo: data })
    } catch (cause) { setError(messageOf(cause)) }
  }
  const previewSlots = channelSlots(draft?.channels.map((entry) => entry.id) ?? [])

  return createPortal(<dialog ref={dialogRef} className="settings-dialog" aria-labelledby="settings-heading"
    onCancel={(event) => { event.preventDefault(); requestClose() }} onClose={() => { if (!dialogRef.current?.open) onClose() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose()
    }}>
    <header className="settings-header">
      <div className="settings-title"><span className="settings-heading-icon"><Icon name="settings" /></span><div><h2 id="settings-heading">工作台设置</h2><p>让工作台按你的习惯运转</p></div></div>
      <button type="button" className="log-history-close" aria-label="关闭设置" disabled={busy} onClick={requestClose} autoFocus><Icon name="close" /></button>
    </header>
    <form className="settings-form" onSubmit={(event) => void handleSave(event)}>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <span className="settings-nav-label">个人工作空间</span>
          <button type="button" disabled={busy} className={tab === 'model' ? 'is-active' : ''} aria-current={tab === 'model' ? 'page' : undefined} onClick={() => setTab('model')}><Icon name="model" /><span>模型配置<small>大模型连接与密钥</small></span></button>
          <button type="button" disabled={busy} className={tab === 'channels' ? 'is-active' : ''} aria-current={tab === 'channels' ? 'page' : undefined} onClick={() => setTab('channels')}><Icon name="sources" /><span>采集源<small>渠道、顺序与路径</small></span>{draft && <b>{draft.channels.length}</b>}</button>
          <button type="button" disabled={busy} className={tab === 'automation' ? 'is-active' : ''} aria-current={tab === 'automation' ? 'page' : undefined} onClick={() => setTab('automation')}><Icon name="clock" /><span>自动化<small>采集、通知与定时报告</small></span></button>
          <button type="button" disabled={busy} className={tab === 'mcp' ? 'is-active' : ''} aria-current={tab === 'mcp' ? 'page' : undefined} onClick={() => setTab('mcp')}><Icon name="sources" /><span>MCP 接入<small>助手权限与接入配置</small></span></button>
          <p className="settings-nav-note"><Icon name="check" />设置保存在本机<br />刷新、重启后依然保留</p>
        </nav>
        <div className="settings-content">
          {error && <p className="settings-message is-error" role="alert">{error}</p>}
          {feedback && <p className="settings-message is-success" role="status">{feedback}</p>}
          {loading ? <div className="settings-loading" role="status">正在读取工作台设置…</div> : !draft ? <div className="settings-loading"><p>暂时无法读取设置</p><button type="button" className="settings-secondary" onClick={() => setLoadVersion((current) => current + 1)}>重新加载</button></div> : <fieldset disabled={busy} className="settings-fields">
            {tab === 'model' ? <div className="settings-model-page">
              <div className="settings-section-heading"><div><h3>模型配置</h3><p>选择首选模型，连接失败时按顺序使用备用模型</p></div><button type="button" className="settings-secondary" disabled={(draft.models?.length ?? 0) >= 10} onClick={addModel}><Icon name="plus" />添加模型</button></div>
              <div className="settings-model-policy"><div><strong>自动故障切换</strong><p>连接失败后尝试下一模型，1 分钟后重试首选模型。</p></div><button type="button" className={`settings-switch${draft.autoSwitchModels ? ' is-on' : ''}`} role="switch" aria-checked={!!draft.autoSwitchModels} aria-label="自动故障切换" onClick={() => { setDraft({ ...draft, autoSwitchModels: !draft.autoSwitchModels }); setFeedback(null) }}><span /></button></div>
              {modelDirty && <p className="settings-model-pending"><Icon name="clock" />修改尚未生效，保存后首选：{draftPreferred?.label ?? '暂无可用模型'}</p>}
              <div className="settings-model-columns">
                <div className="settings-model-library"><div className="settings-model-list-heading"><strong>我的模型</strong><small>{modelRuntime && !modelRuntime.nextModelId ? '暂无可用模型' : '按备用顺序排列'}</small></div>
                  <ol className="settings-model-list" aria-label="模型优先顺序">
                    {draft.models?.map((entry, index) => {
                      const states = [
                        modelRuntime?.activeModelIds?.includes(entry.id) ? '正在调用' : '',
                        modelRuntime?.nextModelId === entry.id ? modelRuntime.preferredModelId === entry.id ? '下次优先' : '备用接管' : '',
                        modelRuntime?.lastUsedModelId === entry.id ? '最近使用' : '',
                        modelRuntime?.coolingModelIds.includes(entry.id) ? '连接失败 · 等待恢复' : '',
                      ].filter(Boolean)
                      return <li key={entry.id} className={entry.id === model?.id ? 'is-editing' : ''}>
                      <button type="button" className="settings-model-select" aria-pressed={entry.id === model?.id} onClick={() => { setSelectedModelId(entry.id); setShowKey(false); setFeedback(null); setModelTestResult(null); setDeletingModelId(null) }}><span className="settings-model-row-title"><strong>{entry.label || '未命名模型'}</strong><span className={`settings-badge${entry.id === draftPreferred?.id ? ' is-preferred' : ''}`}>{!entry.enabled ? '已停用' : !saved || !draftModelReady(entry, saved) ? '待配置' : entry.id === draftPreferred?.id ? '首选' : '备用'}</span></span><small>{entry.name || '待填写模型名称'}</small><span className="settings-model-row-state" title="调用状态基于已保存配置；首选顺序修改需保存后生效">{states.length ? states.map((state) => <span key={state} className={state.startsWith('连接失败') ? 'is-warning' : 'is-runtime'}>{state}</span>) : entry.id === model?.id ? '正在编辑' : '点击编辑配置'}</span></button>
                      <div className="settings-model-row-actions">{entry.id !== draftPreferred?.id && <button type="button" className="settings-text-button" disabled={!saved || !draftModelReady({ ...entry, enabled: true }, saved)} title={!saved || !draftModelReady({ ...entry, enabled: true }, saved) ? '请先填写地址、模型名称和密钥' : undefined} onClick={() => { changeModels(moveChannel(draft.models!, entry.id, 0).map((item) => item.id === entry.id ? { ...item, enabled: true } : item)) }}>设为首选</button>}<div className="settings-sort-buttons"><button type="button" aria-label={`提高${entry.label}优先级`} disabled={index === 0} onClick={() => changeModels(moveChannel(draft.models!, entry.id, index - 1))}><Icon name="arrow-up" /></button><button type="button" aria-label={`降低${entry.label}优先级`} disabled={index === draft.models!.length - 1} onClick={() => changeModels(moveChannel(draft.models!, entry.id, index + 1))}><Icon name="arrow-down" /></button></div></div>
                    </li> })}
                  </ol><p className="settings-help">点击模型只编辑配置，不会切换正在使用的模型。</p>
                </div>
                <div className="settings-model-editor">
                  <div className="settings-model-editor-heading"><div><span className="settings-model-eyebrow">正在编辑</span><h4>{model?.label || '新模型'}</h4></div><span className={`settings-badge${modelHasSavedKey ? ' is-ready' : ''}`}>{modelHasSavedKey ? '密钥已保存' : '待配置密钥'}</span></div>
                  <div className="settings-model-enabled"><span>启用此模型</span><button type="button" className={`settings-switch${model?.enabled ? ' is-on' : ''}`} role="switch" aria-checked={!!model?.enabled} aria-label="启用此模型" disabled={!!model?.enabled && otherEnabledModels === 0} title={model?.enabled && otherEnabledModels === 0 ? '至少启用一个模型' : undefined} onClick={() => changeModel({ enabled: !model?.enabled })}><span /></button></div>
                  <label className="settings-field">配置名称<input required value={model?.label ?? ''} maxLength={40} placeholder="例如：公司模型、个人模型" onChange={(event) => changeModel({ label: event.target.value })} /></label>
                  <label className="settings-field">模型别名<input value={model?.alias ?? ''} maxLength={16} placeholder="例如：Gemini、GLM Flash" onChange={(event) => changeModel({ alias: event.target.value })} /><small>用于芯片展示，最多 16 个字符；留空使用配置名称，不影响实际调用的模型名称。</small></label>
                  <SettingsSelect label="API 格式" value={modelApiFormat(model?.apiFormat)} options={modelApiOptions} onChange={(apiFormat) => changeModel({ apiFormat })} help="按上游接口选择格式，与模型品牌无关。" />
                  <label className="settings-field">基础地址 <span className="settings-field-caption">Base URL</span><input type="url" required value={model!.baseUrl} maxLength={2048} placeholder="https://ark.cn-beijing.volces.com/api/coding/v3" onChange={(event) => changeModel({ baseUrl: event.target.value })} /><small>{modelApiHelp(modelApiFormat(model?.apiFormat))}</small></label>
                  <label className="settings-field">模型名称<input required value={model!.name} maxLength={160} placeholder="glm-5.3-flash" onChange={(event) => changeModel({ name: event.target.value })} /></label>
                  <div className="settings-field"><label htmlFor="settings-api-key">API Key</label><div className="settings-key-input"><input id="settings-api-key" type={showKey ? 'text' : 'password'} autoComplete="new-password" value={model!.apiKey ?? ''} disabled={busy || model!.clearApiKey} placeholder={modelHasSavedKey ? '已配置 · 留空保留现有密钥' : '输入模型服务的 API Key'} maxLength={4096} onChange={(event) => changeModel({ apiKey: event.target.value })} /><button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey} onClick={() => setShowKey((current) => !current)}><Icon name="eye" /></button></div><small>密钥仅保存在服务端，不会回传明文，也不会存入浏览器缓存。更换基础地址或 API 格式后需要重新填写密钥。</small></div>
                  <div className="settings-model-actions"><div className="settings-connection-test"><button type="button" className="settings-secondary" onClick={() => void handleTest()}><Icon name="refresh" />{testing ? '连接测试中…' : '测试连接'}</button>{modelTestResult && modelTestResult.id === model?.id && <p className={`settings-test-result${modelTestResult.success ? ' is-success' : ' is-error'}`} role={modelTestResult.success ? 'status' : 'alert'}>{modelTestResult.success && <Icon name="check" />}<span>{modelTestResult.message}</span></p>}</div>{modelSaved?.hasApiKey && <label className="settings-checkbox"><input type="checkbox" checked={!!model!.clearApiKey} onChange={(event) => changeModel({ clearApiKey: event.target.checked, apiKey: '' })} />清除已保存密钥</label>}</div>

                  <div className="settings-model-remove">
                    {deletingModelId === model?.id ? <><p>从配置中移除“{model?.label}”？保存设置后生效。</p><div><button type="button" className="settings-secondary" onClick={() => setDeletingModelId(null)}>取消</button><button type="button" className="settings-secondary is-danger" onClick={() => { changeModels(draft.models!.filter((entry) => entry.id !== model?.id)); setSelectedModelId(''); setShowKey(false) }}>确认移除</button></div></> : <><small>{draft.models?.length === 1 ? '至少保留一个模型配置。' : !canRemoveModel ? '先启用其他模型，再移除此模型。' : '移除配置不会删除已有工作记录。'}</small><button type="button" className="settings-text-button is-danger" disabled={!canRemoveModel} onClick={() => setDeletingModelId(model!.id)}><Icon name="trash" />移除此模型</button></>}
                  </div>
                </div>
              </div>
              <p className="settings-help settings-model-data-note">故障切换会将同一请求发送给备用模型，请仅启用可处理这些资料的服务。</p>
            </div> : tab === 'channels' ? <div className="settings-channels-page">
              <div className="settings-section-heading"><div><h3>采集源</h3><p>拖动调整顺序，也可使用上下箭头。首页与详情同步显示。</p></div><button type="button" className="settings-secondary" disabled={draft.channels.length >= 30} onClick={addChannel}><Icon name="plus" />添加渠道</button></div>
              <div className="settings-channel-columns">
                <ol className="settings-channel-list" aria-label="采集源显示顺序">
                  {draft.channels.map((entry, index) => <li key={entry.id} className={`${selectedId === entry.id ? 'is-selected' : ''}${dragged === entry.id ? ' is-dragging' : ''}`} draggable={!busy}
                    onDragStart={(event) => { setDragged(entry.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.id) }} onDragEnd={() => setDragged(null)}
                    onDragOver={(event) => { if (dragged) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                    onDrop={(event) => { event.preventDefault(); if (dragged) reorder(dragged, index); setDragged(null) }}>
                    <span className="settings-drag-handle" aria-hidden="true"><Icon name="grip" /></span>
                    <button type="button" className="settings-channel-select" aria-pressed={selectedId === entry.id} onClick={() => setSelectedId(entry.id)}><span className="settings-channel-logo"><ChannelLogo logo={entry.logo} name={entry.name} size={30} /></span><span><strong>{entry.name || '未命名渠道'}</strong><small>{!entry.enabled ? '已停用' : entry.collector === 'none' ? '待接入' : COLLECTORS[entry.collector]}</small></span></button>
                    <div className="settings-sort-buttons"><button type="button" disabled={index === 0} aria-label={`上移 ${entry.name}`} onClick={() => reorder(entry.id, index - 1)}><Icon name="arrow-up" /></button><button type="button" disabled={index === draft.channels.length - 1} aria-label={`下移 ${entry.name}`} onClick={() => reorder(entry.id, index + 1)}><Icon name="arrow-down" /></button></div>
                  </li>)}
                </ol>
                {channel && <section className="settings-channel-editor" aria-label={`${channel.name} 的配置`}>
                  <div className="settings-channel-editor-heading"><span className="settings-editor-logo"><ChannelLogo logo={channel.logo} name={channel.name} size={42} /></span><div><strong>{channel.name || '未命名渠道'}</strong><small>第 {draft.channels.indexOf(channel) + 1} 个渠道</small></div><button type="button" role="switch" aria-checked={channel.enabled} aria-label={`启用 ${channel.name}`} className={`settings-switch${channel.enabled ? ' is-on' : ''}`} onClick={() => changeChannel(channel.id, { enabled: !channel.enabled })}><span /></button></div>
                  <label className="settings-field">渠道名称<input required value={channel.name} maxLength={40} onChange={(event) => changeChannel(channel.id, { name: event.target.value })} /></label>
                  <div className="settings-field"><span>渠道 Logo</span><div className="settings-logo-actions"><button type="button" className="settings-secondary" onClick={() => uploadRef.current?.click()}><Icon name="upload" />上传图片</button><button type="button" className="settings-text-button" onClick={() => changeChannel(channel.id, { logo: sourceInfo(channel.id as ChannelId).logo })}>恢复默认</button></div><small>PNG、JPEG 或 WebP，最大 256 KB；未上传时使用名称图标。</small><input ref={uploadRef} className="settings-file-input" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传渠道 Logo" onChange={(event) => { void uploadLogo(event.target.files?.[0]); event.target.value = '' }} /></div>
                  <SettingsSelect key={channel.id} label="记录读取方式" value={channel.collector} options={collectorLocked ? collectorOptions : compatibleOptions} disabled={busy || collectorLocked}
                    onChange={(collector) => { changeChannel(channel.id, { collector }); setScanFeedback(null); setScanChoices(null) }}
                    help={channel.collector === 'zentao' ? '读取个人 Bug、任务，以及账号可见项目的测试管理事项。' : collectorLocked ? '使用该渠道的专用读取器。' : channel.collector === 'auto' ? '识别已支持的工具记录，也会尝试通用 JSON / JSONL，不受渠道名称限制。' : channel.collector === 'generic' ? '读取其他工具导出的 JSON / JSONL，可配置字段对应关系。' : '只展示渠道，暂不读取会话。'} />
                  {channel.collector === 'zentao' ? <>
                    <label className="settings-field">禅道地址<input type="url" required={channel.enabled} value={channel.zentao?.baseUrl ?? ''} maxLength={2048} placeholder="http://你的禅道地址/zentao" onChange={(event) => changeZentao({ baseUrl: event.target.value })} /><small>填写禅道首页地址，使用 V2 接口采集。</small></label>
                    <label className="settings-field">禅道账号<input required={channel.enabled} autoComplete="username" value={channel.zentao?.account ?? ''} maxLength={100} onChange={(event) => changeZentao({ account: event.target.value })} /></label>
                    <div className="settings-field"><label htmlFor="settings-zentao-password">禅道密码</label><div className="settings-key-input"><input id="settings-zentao-password" type={showZentaoPassword ? 'text' : 'password'} autoComplete="new-password" value={channel.zentao?.password ?? ''} disabled={busy || channel.zentao?.clearPassword} maxLength={4096} placeholder={channelSaved?.zentao?.hasPassword ? '已配置 · 留空保留现有密码' : '输入禅道登录密码'} onChange={(event) => changeZentao({ password: event.target.value })} /><button type="button" aria-label={showZentaoPassword ? '隐藏禅道密码' : '显示禅道密码'} aria-pressed={showZentaoPassword} onClick={() => setShowZentaoPassword((current) => !current)}><Icon name="eye" /></button></div><small>密码仅保存在服务端，不会回传明文或存入浏览器缓存；更换地址或账号后需重新填写。</small></div>
                    <div className="settings-model-actions"><button type="button" className="settings-secondary" onClick={() => void handleTestZentao()}><Icon name="refresh" />{testing ? '连接测试中…' : '测试禅道连接'}</button>{channelSaved?.zentao?.hasPassword && <label className="settings-checkbox"><input type="checkbox" checked={!!channel.zentao?.clearPassword} onChange={(event) => changeZentao({ clearPassword: event.target.checked, password: '' })} />清除已保存密码</label>}</div>
                    <fieldset className="settings-management"><legend>测试管理关注事项</legend>
                      <label className="settings-checkbox"><input type="checkbox" checked={channel.zentao?.management?.enabled ?? true} onChange={(event) => changeManagement({ enabled: event.target.checked })} />随禅道同步抽取管理待办</label>
                      <p className="settings-help">关闭后暂停管理采集，已有事项和个人 Bug 采集保留。管理待办及其日报摘要通过本地规则生成。</p>
                      <label className="settings-field">计划上线时间字段路径<input value={channel.zentao?.management?.plannedReleaseField ?? ''} placeholder="例如 customFields.plannedReleaseAt" maxLength={300} onChange={(event) => changeManagement({ plannedReleaseField: event.target.value })} /><small>填写需求接口中的实际字段路径；留空时仅识别准确的中文字段名“计划上线时间”。</small></label>
                      <label className="settings-field">实际上线时间字段路径<input value={channel.zentao?.management?.actualReleaseField ?? ''} placeholder="例如 customFields.actualReleaseAt" maxLength={300} onChange={(event) => changeManagement({ actualReleaseField: event.target.value })} /><small>未返回字段会标记待更新，只有明确未填写才使用冲刺日期兜底。</small></label>
                      <button type="button" className="settings-secondary" disabled={busy} onClick={() => void handleInspectFields()}>{testing ? '核对中…' : '核对需求接口字段'}</button>
                      {fieldPreview && <details className="management-field-preview" open><summary>需求 #{fieldPreview.storyId} 的字段核对结果</summary>
                        <p>{fieldPreview.message}</p><p>计划字段：{fieldPreview.planned === 'unavailable' ? '未返回' : fieldPreview.planned === 'empty' ? '已返回，未填写' : '已返回，有值'} · 实际字段：{fieldPreview.actual === 'unavailable' ? '未返回' : fieldPreview.actual === 'empty' ? '已返回，未填写' : '已返回，有值'}</p>
                        <ul>{fieldPreview.candidates.map((entry) => <li key={entry.path}><code>{entry.path}</code><small>{entry.label}</small></li>)}</ul>
                        <p>将对应的自定义字段路径填写到上方，再次核对后保存。</p>
                      </details>}
                      <div className="settings-management-thresholds">{([['warningDays', '临期提前天数', 1], ['reviewDays', '评审等待天数', 1]] as const).map(([key, label, min]) =>
                        <label key={key} className="settings-field">{label}<input type="number" min={min} max={30} required value={channel.zentao?.management?.[key] ?? defaultZentaoManagement[key]} onChange={(event) => changeManagement({ [key]: event.target.valueAsNumber })} /></label>)}</div>
                    </fieldset>
                    <p className="settings-channel-placeholder">采集分配给你的待处理 Bug，以及未开始、进行中、暂停的任务。待处理 Bug 在禅道解决或关闭后自动同步进工作日志；其它禅道事项及手工事项可在工作台手动标记完成。</p>
                  </> : channel.collector === 'none' ? <p className="settings-channel-placeholder">选择“自动识别”并配置本机会话目录，即可检测和采集记录。</p> : <>
                    <div className="settings-field"><span>路径获取方式</span><div className="settings-segmented" role="group" aria-label="路径获取方式"><button type="button" aria-pressed={channel.pathMode === 'scan'} className={channel.pathMode === 'scan' ? 'is-active' : ''} onClick={() => { changeChannel(channel.id, { pathMode: 'scan' }); setScanFeedback(null) }}><Icon name="search" />扫描</button><button type="button" disabled={pathNamesUnavailable} title={pathNamesUnavailable ? '请先重新扫描并识别本机目录' : undefined} aria-pressed={channel.pathMode === 'manual'} className={channel.pathMode === 'manual' ? 'is-active' : ''} onClick={() => changeChannel(channel.id, { pathMode: 'manual' })}>手动输入</button></div></div>
                    {channel.pathMode === 'scan' ? <div className="settings-scan-area"><p>{compatibleCollector ? '查找可读取的会话目录，请勾选属于这个渠道的目录。新工具的目录也可手动填写。' : '查找你的会话目录，并检查读取状态。'}</p><button type="button" className="settings-secondary" onClick={() => void handleScan(channel)}><Icon name="search" />{scanning === channel.id ? '扫描中…' : '扫描路径'}</button>
                      {compatibleCollector && scanChoices?.id === channel.id && scanChoices.paths.length > 0 && <div className="settings-scan-choices" role="group" aria-label="选择采集目录">{scanChoices.paths.map((path) => <label key={path}><input type="checkbox" checked={channel.paths.includes(path)} disabled={!channel.paths.includes(path) && channel.paths.length >= 10} onChange={(event) => changeChannel(channel.id, { paths: event.target.checked ? [...channel.paths, path] : channel.paths.filter((entry) => entry !== path) })} /><code>{path}</code></label>)}</div>}
                    </div> : pathNamesUnavailable ? <p className="settings-path-error">暂时无法识别本机目录，请切换到扫描，或请管理员检查目录配置。</p> : <label className="settings-field">本机采集目录<textarea rows={4} value={channel.paths.join('\n')} placeholder="/Users/你的用户名/会话目录" onChange={(event) => changeChannel(channel.id, { paths: event.target.value.split('\n') })} /><small>每行填写一个本机目录，支持 ~/；不同渠道可以使用各自的会话目录。</small></label>}
                    <SourcePathDetails key={channel.id} collector={channel.collector} paths={channel.paths} refreshVersion={pathCheckVersion} />
                    {scanFeedback?.id === channel.id && <p className="settings-scan-feedback" role="status">{scanFeedback.message}</p>}
                    {compatibleCollector && <RecordCompatibility key={channel.id} collector={channel.collector as 'auto' | 'generic'} paths={channel.paths} mapping={channel.mapping} disabled={busy || pathNamesUnavailable} onMappingChange={(mapping) => changeChannel(channel.id, { mapping })} />}
                  </>}
                  {!channel.enabled && <p className="settings-help">保存后暂停该渠道采集，已有工作记录继续保留。</p>}
                </section>}
              </div>
              <section className="settings-dock-preview" aria-label="首页渠道预览"><header><strong>首页预览</strong><span>按当前顺序展示，超出四个时收进“更多”</span></header><div>{previewSlots.map((slot) => {
                const entry = draft.channels.find((item) => item.id === slot.sources[0])!
                return <span className="settings-preview-channel" key={slot.id}>{slot.overflow ? <span className="settings-preview-more">+{slot.sources.length}</span> : <ChannelLogo logo={entry.logo} name={entry.name} size={32} />}<small>{slot.overflow ? '更多' : entry.name}</small></span>
              })}</div></section>
            </div> : tab === 'mcp' ? <McpSettings onBusyChange={setMcpBusy} /> : <div className="settings-automation-page">
              <div className="settings-section-heading"><div><h3>自动化</h3><p>配置自动采集、待办通知与定时报告</p></div></div>
              <section className="settings-automation-card" aria-labelledby="settings-notifications-heading">
                <div className="settings-section-heading">
                  <div><h4 id="settings-notifications-heading">待办通知</h4><p>禅道同步或计划任务产生新待办时，发送 Mac 系统通知</p></div>
                  <button type="button" role="switch" aria-checked={notificationsEnabled} aria-label="待办通知"
                    className={`settings-switch${notificationsEnabled ? ' is-on' : ''}`} disabled={requestingNotifications}
                    onClick={onToggleNotifications}><span /></button>
                </div>
                <p className="settings-help" role="status">{requestingNotifications ? '正在开启通知…' : notificationDescription}</p>
                <p className="settings-help">此开关立即生效，仅保存在当前浏览器，无需点击保存。历史待办不提醒，后台运行可能延迟，关闭工作台后停止接收。</p>
              </section>
              <section className="settings-automation-card" aria-labelledby="settings-sync-heading">
                <div className="settings-section-heading"><div><h4 id="settings-sync-heading">自动采集</h4><p>定时检查各渠道的待办、会话与工作进展</p></div><button type="button" role="switch" aria-checked={draft.sync.enabled} aria-label="自动采集" className={`settings-switch${draft.sync.enabled ? ' is-on' : ''}`} onClick={() => setDraft((current) => current && { ...current, sync: { ...current.sync, enabled: !current.sync.enabled } })}><span /></button></div>
                <label className="settings-interval">采集间隔<div><input type="number" min={1} max={1440} step={1} value={draft.sync.intervalMs / 60000} onChange={(event) => setDraft((current) => current && { ...current, sync: { ...current.sync, intervalMs: Number(event.target.value) * 60000 } })} /><span>分钟</span></div></label>
                <p className="settings-help">{draft.sync.enabled ? '保存后重新计算下次采集时间，正在进行的同步会继续完成。' : '已暂停定时采集，仍可在首页点击“立即同步”。'}</p>
              </section>
              <section className="settings-automation-card" aria-labelledby="settings-report-schedule-heading">
                <div className="settings-section-heading"><div><h4 id="settings-report-schedule-heading">自动生成日报</h4><p>到达指定时间点时，自动将今日日志整理并入日报</p></div><button type="button" role="switch" aria-checked={draft.dailyReportSchedule.enabled} aria-label="自动生成日报" className={`settings-switch${draft.dailyReportSchedule.enabled ? ' is-on' : ''}`} onClick={() => setDraft((current) => current && { ...current, dailyReportSchedule: { ...current.dailyReportSchedule, enabled: !current.dailyReportSchedule.enabled } })}><span /></button></div>
                <p className="settings-help">{draft.dailyReportSchedule.enabled ? '到达设定时间后，将自动对今日日志进行增量整理，不会覆盖已手动编辑的修改。若当天暂无工作日志则静默跳过。' : '已关闭定时生成日报。你仍可随时在日报页面点击“生成日报”或“补充整理”。'}</p>
                {draft.dailyReportSchedule.enabled && <div className="settings-schedule-body">
                  <div className="settings-field">
                    <span>生成时间点列表 ({draft.dailyReportSchedule.times.length}/24)</span>
                    {draft.dailyReportSchedule.times.length === 0 ? <p className="settings-schedule-empty">尚未添加时间点，请在下方添加自动生成的执行时间。</p> : <div className="settings-schedule-tags" role="list" aria-label="已配置的时间点">
                      {draft.dailyReportSchedule.times.map((time) => <span key={time} className="settings-schedule-tag" role="listitem">
                        <Icon name="clock" />
                        <strong>{time}</strong>
                        <button type="button" aria-label={`删除 ${time}`} title={`删除 ${time}`} onClick={() => removeTime(time)}><Icon name="close" /></button>
                      </span>)}
                    </div>}
                  </div>
                  <div className="settings-field">
                    <span>添加时间点</span>
                    <div className="settings-schedule-input-row">
                      <input type="time" value={newTime} aria-label="选择时间" onChange={(event) => setNewTime(event.target.value)} />
                      <button type="button" className="settings-secondary" disabled={!newTime || draft.dailyReportSchedule.times.includes(newTime) || draft.dailyReportSchedule.times.length >= 24} onClick={() => addTime(newTime)}><Icon name="plus" />添加时间点</button>
                    </div>
                  </div>
                  <div className="settings-schedule-presets">
                    <span className="settings-presets-label">常用预设：</span>
                    {[
                      { label: '中午 12:00', time: '12:00' },
                      { label: '傍晚 18:00', time: '18:00' },
                      { label: '晚间 21:00', time: '21:00' },
                    ].map((preset) => {
                      const exists = draft.dailyReportSchedule.times.includes(preset.time)
                      return <button key={preset.time} type="button" className="settings-preset-button" disabled={exists || draft.dailyReportSchedule.times.length >= 24} onClick={() => addTime(preset.time)}>{exists ? `✓ ${preset.label}` : `+ ${preset.label}`}</button>
                    })}
                  </div>
                </div>}
              </section>

              <section className="settings-automation-card" aria-labelledby="settings-weekly-schedule-heading">
                <div className="settings-section-heading">
                  <div>
                    <h4 id="settings-weekly-schedule-heading">自动整理工作周报</h4>
                    <p>到达每周指定时间后，自动汇总本周日报与完成事项并归档为周报</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.periodicReportSchedule.weeklyEnabled}
                    aria-label="自动整理工作周报"
                    className={`settings-switch${draft.periodicReportSchedule.weeklyEnabled ? ' is-on' : ''}`}
                    onClick={() => setDraft((current) => current && {
                      ...current,
                      periodicReportSchedule: {
                        ...current.periodicReportSchedule,
                        weeklyEnabled: !current.periodicReportSchedule.weeklyEnabled,
                      },
                    })}
                  >
                    <span />
                  </button>
                </div>
                <p className="settings-help">
                  {draft.periodicReportSchedule.weeklyEnabled
                    ? '到达设定时间后，后台将自动提炼本周核心进展、推进中事项与下周计划，生成本周周报存入个人空间。'
                    : '已关闭自动周报整理。你仍可随时在个人空间点击“重新整理”。'}
                </p>
                {draft.periodicReportSchedule.weeklyEnabled && (
                  <div className="settings-schedule-body">
                    <div className="settings-schedule-input-row">
                      <div className="settings-label-inline">
                        <span>执行星期：</span>
                        <SettingsSelect
                          compact
                          width={152}
                          label="执行星期"
                          value={String(draft.periodicReportSchedule.weeklyDay)}
                          options={[
                            { value: '5', label: '每周五（推荐）' },
                            { value: '6', label: '每周六' },
                            { value: '7', label: '每周日' },
                            { value: '1', label: '每周一' },
                          ]}
                          onChange={(val) => setDraft((current) => current && {
                            ...current,
                            periodicReportSchedule: {
                              ...current.periodicReportSchedule,
                              weeklyDay: Number(val),
                            },
                          })}
                        />
                      </div>
                      <div className="settings-label-inline">
                        <span>执行时间：</span>
                        <input
                          type="time"
                          value={draft.periodicReportSchedule.weeklyTime}
                          onChange={(e) => setDraft((current) => current && {
                            ...current,
                            periodicReportSchedule: {
                              ...current.periodicReportSchedule,
                              weeklyTime: e.target.value,
                            },
                          })}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </section>

              <section className="settings-automation-card" aria-labelledby="settings-monthly-schedule-heading">
                <div className="settings-section-heading">
                  <div>
                    <h4 id="settings-monthly-schedule-heading">自动整理月度复盘</h4>
                    <p>到达每月最后一天指定时间后，自动汇总整月工作里程碑与规划</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.periodicReportSchedule.monthlyEnabled}
                    aria-label="自动整理月度复盘"
                    className={`settings-switch${draft.periodicReportSchedule.monthlyEnabled ? ' is-on' : ''}`}
                    onClick={() => setDraft((current) => current && {
                      ...current,
                      periodicReportSchedule: {
                        ...current.periodicReportSchedule,
                        monthlyEnabled: !current.periodicReportSchedule.monthlyEnabled,
                      },
                    })}
                  >
                    <span />
                  </button>
                </div>
                <p className="settings-help">
                  {draft.periodicReportSchedule.monthlyEnabled
                    ? '到达月末设定时间后，后台将自动汇总整月交付成果与长期目标，生成月度复盘报告存入个人空间。'
                    : '已关闭自动月报整理。你仍可随时在个人空间点击“重新整理”。'}
                </p>
                {draft.periodicReportSchedule.monthlyEnabled && (
                  <div className="settings-schedule-body">
                    <div className="settings-schedule-input-row">
                      <span className="settings-label-text">执行日期：每月最后一天</span>
                      <label className="settings-label-inline">
                        <span>执行时间：</span>
                        <input
                          type="time"
                          value={draft.periodicReportSchedule.monthlyTime}
                          onChange={(e) => setDraft((current) => current && {
                            ...current,
                            periodicReportSchedule: {
                              ...current.periodicReportSchedule,
                              monthlyTime: e.target.value,
                            },
                          })}
                        />
                      </label>
                    </div>
                  </div>
                )}
              </section>
            </div>}
          </fieldset>}
        </div>
      </div>
      {discarding && <div className="settings-discard" role="alert"><span>还有未保存的修改。</span><button type="button" onClick={() => setDiscarding(false)}>继续编辑</button><button type="button" onClick={onClose}>放弃修改并关闭</button></div>}
      <footer className="settings-footer"><span className={dirty ? 'has-changes' : ''}><i />{saving ? '正在保存配置…' : dirty ? '有未保存的更改' : tab === 'mcp' ? 'MCP 更改即时保存' : '配置保存在本机'}</span><div><button type="button" className="settings-secondary" disabled={busy} onClick={requestClose}>关闭</button><button type="submit" className="settings-primary" disabled={!draft || busy || !dirty || tab === 'mcp'}><Icon name="check" />{saving ? '保存中…' : '保存设置'}</button></div></footer>
    </form>
  </dialog>, document.body)
}
