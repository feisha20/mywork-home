import { useEffect, useState } from 'react'
import { mcpClientConfig, type McpSettingsView } from '../../shared/mcp'
import { createMcpClient, fetchMcpSettings, revokeMcpClient, setMcpEnabled } from '../data/apiRepository'
import { copyReportText } from '../data/clipboard'
import { SettingsSelect } from './SettingsSelect'
import { Icon } from './Icon'

export function McpSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [settings, setSettings] = useState<McpSettingsView | null>(null)
  const [name, setName] = useState('Codex')
  const [permission, setPermission] = useState<'read' | 'write'>('read')
  const [evidence, setEvidence] = useState(false)
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void fetchMcpSettings(controller.signal).then(setSettings).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'MCP 设置读取失败')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); onBusyChange(true); setError(null); setFeedback(null)
    try { await work() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试') }
    finally { setBusy(false); onBusyChange(false) }
  }
  async function issue() {
    const created = await createMcpClient({ name: name.trim(), canWrite: permission === 'write', canReadEvidence: evidence })
    // 令牌只在当前组件内存中显示一次，不写入本地存储；配置读取也不会再回传明文。
    setIssued({ id: created.client.id, token: created.token })
    setSettings((current) => current && { ...current, clients: [created.client, ...current.clients] })
    setFeedback('客户端已创建，请保存令牌或复制接入配置。')
  }
  async function copy(kind: 'token' | 'codex' | 'zcode') {
    if (!issued || !settings) return
    await copyReportText(kind === 'token' ? issued.token : mcpClientConfig(kind, settings.endpoint, issued.token))
    setFeedback(kind === 'token' ? '令牌已复制。' : `${kind === 'codex' ? 'Codex' : 'Zcode'} 接入配置已复制。`)
  }
  if (loading) return <div className="settings-loading" role="status">正在读取 MCP 接入设置…</div>
  if (!settings) return <div className="settings-loading"><p role="alert">{error}</p><button type="button" className="settings-secondary" onClick={() => setReload((value) => value + 1)}>重新读取</button></div>
  return <div className="settings-mcp-page">
    <div className="settings-section-heading"><div><h3>MCP 接入</h3><p>让 Codex、Zcode 查询工作资料，并保存待办和报告。</p></div>
      <button type="button" role="switch" aria-checked={settings.enabled} aria-label="启用 MCP 接入" className={`settings-switch${settings.enabled ? ' is-on' : ''}`} disabled={busy}
        onClick={() => void action(async () => { setSettings(await setMcpEnabled(!settings.enabled)) })}><span /></button></div>
    {error && <p className="settings-message is-error" role="alert">{error}</p>}
    {feedback && <p className="settings-message is-success" role="status">{feedback}</p>}
    <label className="settings-field">服务地址<input readOnly value={settings.endpoint} /><small>仅供同一台 Mac 使用。查询结果会进入当前助手的对话上下文；个人事项不开放。</small></label>
    <section className="settings-automation-card">
      <div className="settings-section-heading"><div><h4>创建客户端令牌</h4><p>为每个助手单独创建，按需授权，修改即时保存。</p></div></div>
      <label className="settings-field">客户端名称<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="例如 Codex 或 Zcode" /></label>
      <SettingsSelect label="操作权限" value={permission} onChange={setPermission} options={[{ value: 'read', label: '仅查询分析' }, { value: 'write', label: '查询与有限本地修改' }]} help="本地修改包括创建待办、更新允许的待办及保存报告，不修改禅道远端。" />
      <label className="mcp-evidence-choice"><input type="checkbox" checked={evidence} onChange={(event) => setEvidence(event.target.checked)} />允许按需读取脱敏来源证据</label>
      <button type="button" className="settings-primary" disabled={busy || !name.trim() || !!issued} onClick={() => void action(issue)}><Icon name="plus" />创建令牌</button>
    </section>
    {issued && <section className="settings-automation-card mcp-issued" aria-label="新客户端令牌">
      <label className="settings-field">新令牌<input readOnly type="password" value={issued.token} autoComplete="off" /><small>仅本次显示，关闭此页后无法再次读取。配置含令牌，请保存在个人配置中，不提交 Git。</small></label>
      <div className="mcp-actions"><button type="button" className="settings-secondary" onClick={() => void action(() => copy('token'))}>复制令牌</button>
        <button type="button" className="settings-secondary" onClick={() => void action(() => copy('codex'))}>复制 Codex 配置</button>
        <button type="button" className="settings-secondary" onClick={() => void action(() => copy('zcode'))}>复制 Zcode 配置</button>
        <button type="button" className="settings-secondary" onClick={() => setIssued(null)}>我已保存，隐藏令牌</button></div>
      <p className="settings-help">Codex 配置添加到个人 config.toml；Zcode 在设置 → MCP 服务器 → 新建 → 完整配置中粘贴。</p>
    </section>}
    <section className="settings-automation-card">
      <div className="settings-section-heading"><div><h4>已创建客户端</h4><p>调整权限时撤销旧令牌，再创建新令牌。撤销后下一次调用立即失效。</p></div></div>
      {!settings.clients.length && <p className="settings-help">尚未创建客户端。</p>}
      <ul className="mcp-client-list">{settings.clients.map((client) => <li key={client.id}><div><strong>{client.name}</strong>
        <small>{client.revokedAt ? '已撤销' : `${client.canWrite ? '查询与本地修改' : '只读'} · ${client.canReadEvidence ? '可读证据' : '仅摘要'}`}</small></div>
        <button type="button" className="settings-secondary" disabled={busy || !!client.revokedAt} onClick={() => void action(async () => {
          await revokeMcpClient(client.id)
          setSettings((current) => current && { ...current, clients: current.clients.map((entry) => entry.id === client.id ? { ...entry, revokedAt: new Date().toISOString() } : entry) })
          if (issued?.id === client.id) setIssued(null)
          setFeedback('客户端令牌已撤销。')
        })}>{client.revokedAt ? '已撤销' : '撤销'}</button></li>)}</ul>
    </section>
  </div>
}
