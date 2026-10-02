import { useEffect, useRef, useState } from 'react'
import { EMPTY_RECORD_MAPPING } from '../../shared/settings'
import type { RecordMapping, RecordPreview } from '../../shared/settings'
import { previewChannelRecords } from '../data/apiRepository'
import { Icon } from './Icon'

const mappingFields = [
  { key: 'messages', label: '消息列表', example: 'messages 或 data.messages' },
  { key: 'role', label: '角色', example: 'role 或 author.role' },
  { key: 'text', label: '正文', example: 'content 或 body.text' },
  { key: 'timestamp', label: '消息时间', example: 'timestamp 或 created_at' },
  { key: 'sessionId', label: '会话标识', example: 'sessionId 或 conversation_id' },
  { key: 'messageId', label: '消息标识', example: 'id 或 message.id' },
  { key: 'projectPath', label: '项目目录', example: 'cwd 或 project_path' },
] as const

export function RecordCompatibility({ collector, paths, mapping, disabled, onMappingChange }: {
  collector: 'auto' | 'generic'; paths: string[]; mapping?: RecordMapping; disabled: boolean
  onMappingChange: (mapping: RecordMapping) => void
}) {
  const [preview, setPreview] = useState<RecordPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const signature = JSON.stringify({ collector, paths, mapping })
  // 改动字段或目录后清除旧结果，避免把另一份草稿的预览当成当前配置。
  useEffect(() => {
    requestRef.current?.abort(); requestRef.current = null
    setPreview(null); setError(null); setChecking(false)
    return () => { requestRef.current?.abort() }
  }, [signature])

  async function checkRecords() {
    const controller = new AbortController()
    requestRef.current?.abort(); requestRef.current = controller
    setChecking(true); setError(null); setPreview(null)
    try {
      const result = await previewChannelRecords(collector, paths.map((path) => path.trim()).filter(Boolean), mapping, controller.signal)
      if (!controller.signal.aborted) setPreview(result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '检测失败，请重新检查目录和字段')
    } finally { if (!controller.signal.aborted) { setChecking(false); requestRef.current = null } }
  }

  return <section className="settings-records" aria-label="记录兼容性">
    {collector === 'generic' && <details className="settings-record-mapping" open>
      <summary>字段对应关系<span>留空自动匹配常用字段</span><Icon name="chevron-down" /></summary>
      <p className="settings-help">填写 JSON 字段名，嵌套字段用点分隔。消息列表从文件根节点读取，其余字段从每条消息读取，也会继承会话标识和项目目录。角色支持 user / human、assistant / ai / model；时间支持 ISO 时间、秒或毫秒时间戳。</p>
      <div className="settings-mapping-grid">{mappingFields.map(({ key, label, example }) => <label className="settings-field" key={key}>{label}<input
        value={(mapping ?? EMPTY_RECORD_MAPPING)[key]} maxLength={160} placeholder={example} disabled={disabled}
        onChange={(event) => onMappingChange({ ...(mapping ?? EMPTY_RECORD_MAPPING), [key]: event.target.value })} /></label>)}</div>
    </details>}
    <div className="settings-record-check-heading"><div><strong>检测记录</strong><p>检查格式并预览可采集正文，不调用模型。</p></div>
      <button type="button" className="settings-secondary" disabled={disabled || checking || !paths.some((path) => path.trim())} onClick={() => void checkRecords()}><Icon name="search" />{checking ? '检测中…' : preview ? '重新检测' : '检测记录'}</button>
    </div>
    {checking && <p className="settings-help" role="status">正在读取会话样本…</p>}
    {error && <p className="settings-path-error" role="alert">{error}</p>}
    {preview && <div className="settings-record-result" role="status">
      <p className={preview.compatibleFiles ? 'is-ready' : ''}><Icon name={preview.compatibleFiles ? 'check' : 'sources'} />已检查 {preview.checkedFiles} 个文件，其中 {preview.compatibleFiles} 个可解析</p>
      {preview.formats.length > 0 && <div className="settings-record-formats">{preview.formats.map((format) => <span key={format}>{format}</span>)}</div>}
      {preview.issues.length > 0 && <ul className="settings-record-issues">{preview.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      {preview.messages.length > 0 && <details className="settings-record-samples"><summary>查看会话预览<span>{preview.messages.length} 条</span><Icon name="chevron-down" /></summary>
        <ol>{preview.messages.map((message, index) => <li key={index}><div><strong>{message.role === 'user' ? '用户' : '助手'}</strong><time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false })}</time></div><p>{message.text}</p></li>)}</ol>
      </details>}
      {collector === 'auto' && preview.compatibleFiles < preview.checkedFiles && <p className="settings-help">未识别的 JSON / JSONL 可以切换到“通用 JSON / JSONL”，填写字段后重新检测。</p>}
    </div>}
  </section>
}
