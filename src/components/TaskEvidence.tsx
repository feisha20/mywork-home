import { useEffect, useRef, useState } from 'react'
import type { Task } from '../domain/workbench'
import type { Evidence } from '../../shared/contracts'
import { fetchTaskEvidence } from '../data/apiRepository'

export function TaskEvidence({ task }: { task: Task }) {
  const [evidence, setEvidence] = useState<Evidence[] | null>(task.evidence ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    setEvidence(task.evidence ?? null); setLoading(false); setError(null)
    if (detailsRef.current?.open && !task.evidence) void load(true)
    return () => controller.current?.abort()
  }, [task.evidence, task.id, task.evidenceStale, task.evidenceCount, task.recordedAt, task.completedAt, task.title])
  async function load(force = false) {
    if (!force && (evidence || loading)) return
    const request = new AbortController(); controller.current = request
    setLoading(true); setError(null)
    try { const result = await fetchTaskEvidence(task.id, request.signal); if (!request.signal.aborted) setEvidence(result) }
    catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '来源读取失败') }
    finally { if (!request.signal.aborted) setLoading(false) }
  }
  if (!task.projectPath && !task.evidenceCount && !task.evidence?.length && !task.evidenceStale) return null
  return <details ref={detailsRef} className="task-evidence" onToggle={(event) => { if (event.currentTarget.open) void load() }}>
    <summary>{task.projectPath?.split('/').filter(Boolean).at(-1) ?? '来源'} · 查看证据{task.evidenceStale ? ' · 来源已变更，待核对' : task.statusOrigin === 'manual' ? ' · 手动状态已保留' : ''}</summary>
    {task.projectPath && <p className="evidence-path">{task.projectPath}</p>}
    {loading && <p role="status">正在读取来源…</p>}
    {error && <p role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
    {evidence?.map((entry, index) => <blockquote key={`${entry.messageId}-${index}`} className={entry.valid === false ? 'evidence-invalid' : undefined}>
      <p>{entry.quote}</p><footer>{new Date(entry.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}{entry.valid === false ? ` · ${entry.invalidReason === 'withdrawn' ? '来源已撤回' : '原正文已修改'}，仅作历史参考` : ''}</footer>
    </blockquote>)}
    {evidence?.length === 0 && <p>该事项没有会话证据。</p>}
  </details>
}
