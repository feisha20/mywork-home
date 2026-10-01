import type { Task } from '../domain/workbench'
export function TaskEvidence({ task }: { task: Task }) {
  if (!task.projectPath && !task.evidence?.length) return null
  return <details className="task-evidence">
    <summary>{task.projectPath?.split('/').filter(Boolean).at(-1) ?? '来源'} · 查看证据{task.statusOrigin === 'manual' ? ' · 手动状态已保留' : ''}</summary>
    {task.projectPath && <p className="evidence-path">{task.projectPath}</p>}
    {task.evidence?.map((entry) => <blockquote key={entry.messageId}><p>{entry.quote}</p><small>会话 {entry.sessionId} · {new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.timestamp))}</small></blockquote>)}
  </details>
}
