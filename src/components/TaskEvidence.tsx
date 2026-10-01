import { useState } from 'react'
import type { Task } from '../domain/workbench'
const evidenceTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' })
export function TaskEvidence({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false)
  if (!task.projectPath && !task.evidence?.length) return null
  return <details className="task-evidence" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{task.projectPath?.split('/').filter(Boolean).at(-1) ?? '来源'} · 查看证据{task.statusOrigin === 'manual' ? ' · 手动状态已保留' : ''}</summary>
    {expanded && <>
      {task.projectPath && <p className="evidence-path">{task.projectPath}</p>}
      {task.evidence?.map((entry) => <blockquote key={entry.messageId}><p>{entry.quote}</p><small>会话 {entry.sessionId} · {evidenceTime.format(new Date(entry.timestamp))}</small></blockquote>)}
    </>}
  </details>
}
