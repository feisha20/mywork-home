import { memo, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { SOURCES } from '../domain/workbench'
import type { Task } from '../domain/workbench'
import { Icon } from './Icon'
import { TaskEvidence } from './TaskEvidence'

interface TaskPanelProps {
  tasks: Task[]
  panelRef: RefObject<HTMLElement | null>
  activeId: string | null
  deletingId: string | null
  disabled?: boolean
  onAdd: (title: string) => Promise<void>
  onComplete: (task: Task, button: HTMLButtonElement) => void
  onDelete: (task: Task) => void
}

export const TaskPanel = memo(function TaskPanel({ tasks, panelRef, activeId, deletingId, disabled, onAdd, onComplete, onDelete }: TaskPanelProps) {
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const busy = activeId !== null || !!disabled || adding
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim() || busy) return
    setAdding(true)
    try { await onAdd(title); setTitle('') } catch { /* 请求失败时保留输入内容。 */ }
    finally { setAdding(false) }
  }

  return (
    <section className="dashboard-panel task-panel" ref={panelRef} aria-labelledby="tasks-heading">
      <div className="panel-header">
        <h2 id="tasks-heading"><Icon name="list" />待办事项</h2>
      </div>

      <div className="task-container" aria-label="待办事项">
        {tasks.map((task) => (
          <article
            key={task.id}
            className={`daily-log-card task-card${activeId === task.id ? ' is-transferring' : ''}`}
          >
            <div className="daily-log-top">
              <div className="daily-log-source-group">
                <span className="daily-log-source">{SOURCES[task.source].label}</span>
                <span className="daily-log-reference">{task.reference}</span>
              </div>
            </div>
            <p className="daily-log-text" title={task.title}>{task.title}</p>
            <div className="daily-log-actions">
              <TaskEvidence task={task} />
              <div className="task-action-buttons">
                {task.source === 'manual' && <button className="delete-task" disabled={busy} onClick={() => onDelete(task)} aria-label={`删除待办：${task.title}`}><Icon name="trash" /><span>{deletingId === task.id ? '删除中' : '删除'}</span></button>}
                <button
                  className="reopen-task complete-task"
                  disabled={busy}
                  onClick={(event) => onComplete(task, event.currentTarget)}
                  aria-label={`完成任务：${task.title}`}
                >
                  <span>{activeId === task.id ? '传输中' : '完成'}</span>
                </button>
              </div>
            </div>
          </article>
        ))}
        {tasks.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="check" /></span>
            <h3>待办清空了</h3>
            <p>完成的工作已收进日报。<br />也可以在下方记下下一件事。</p>
          </div>
        )}
      </div>

      <form className="quick-add-box" onSubmit={(event) => { void handleSubmit(event) }}>
        <Icon name="plus" className="quick-add-icon" />
        <input
          className="quick-add-input"
          aria-label="新待办内容"
          placeholder="记下一件待办，回车添加…"
          maxLength={300}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button className="quick-add-btn" disabled={busy || !title.trim()} type="submit">{adding ? '保存中' : '添加'}</button>
      </form>
      <span className="panel-footnote">待办完成后会自动收进工作日志</span>
    </section>
  )
})
