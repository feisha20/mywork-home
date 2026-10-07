import { memo, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { canManualComplete, sourceInfo } from '../domain/workbench'
import type { Task } from '../domain/workbench'
import { Icon } from './Icon'
import { TaskEvidence } from './TaskEvidence'
import { TaskReference, ZentaoTaskDetails } from './TaskReference'
import { PersonalTaskToggle } from './PersonalTaskToggle'
import { ManagementDetails } from './ManagementDetails'

interface TaskPanelProps {
  tasks: Task[]
  panelRef: RefObject<HTMLElement | null>
  activeId: string | null
  deletingId: string | null
  pinningId: string | null
  onTogglePinned: (task: Task) => Promise<void>
  disabled?: boolean
  onAdd: (title: string, isPersonal: boolean) => Promise<void>
  onTogglePersonal: (task: Task) => Promise<Task>
  onComplete: (task: Task, button: HTMLButtonElement) => void
  onDelete: (task: Task) => void
  onIgnore: (task: Task) => void
}

export const TaskPanel = memo(function TaskPanel({ tasks, panelRef, activeId, deletingId, pinningId, onTogglePinned, disabled, onAdd, onTogglePersonal, onComplete, onDelete, onIgnore }: TaskPanelProps) {
  const [title, setTitle] = useState('')
  const [isPersonal, setIsPersonal] = useState(false)
  const [adding, setAdding] = useState(false)
  const busy = activeId !== null || !!disabled || adding
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim() || busy) return
    setAdding(true)
    try { await onAdd(title, isPersonal); setTitle(''); setIsPersonal(false) } catch { /* 请求失败时保留输入内容。 */ }
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
            className={`daily-log-card task-card${task.isPinned ? ' is-pinned' : ''}${activeId === task.id ? ' is-transferring' : ''}`}
          >
            <div className="daily-log-top">
              <div className="daily-log-source-group">
                <span className="daily-log-source">{task.management ? '禅道 · 测试管理' : task.sourceLabel ?? sourceInfo(task.source).label}</span>
                <TaskReference task={task} />
              </div>
              <button type="button" className={`pin-task${task.isPinned ? ' is-pinned' : ''}`} disabled={busy}
                aria-label={`${task.isPinned ? '取消置顶' : '置顶'}待办：${task.title}`} aria-pressed={Boolean(task.isPinned)}
                title={task.isPinned ? '取消置顶' : '置顶待办'} onClick={() => { void onTogglePinned(task) }}>
                <Icon name="pin" /><span>{pinningId === task.id ? '保存中' : task.isPinned ? '已置顶' : '置顶'}</span>
              </button>
            </div>
            <p className="daily-log-text" title={task.title}>{task.title}</p>
            <ZentaoTaskDetails task={task} />
            <ManagementDetails task={task} />
            <div className="daily-log-actions">
              <TaskEvidence task={task} />
              <div className="task-action-buttons">
                <PersonalTaskToggle task={task} disabled={busy} onToggle={onTogglePersonal} />
                {task.management && <button className="reopen-task" disabled={busy} onClick={() => onIgnore(task)} aria-label={`忽略事项：${task.title}`}>忽略</button>}
                {task.source === 'manual' && <button className="delete-task" disabled={busy} onClick={() => onDelete(task)} aria-label={`删除待办：${task.title}`}><Icon name="trash" /><span>{deletingId === task.id ? '删除中' : '删除'}</span></button>}
                {canManualComplete(task) && (
                  <button
                    className="reopen-task complete-task"
                    disabled={busy}
                    onClick={(event) => onComplete(task, event.currentTarget)}
                    aria-label={`完成任务：${task.title}`}
                  >
                    <span>{activeId === task.id ? '传输中' : '完成'}</span>
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
        {tasks.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="check" /></span>
            <h3>待办清空了</h3>
            <p>完成的工作已收进日报。也可以记下下一件事。</p>
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
        <button type="button" className={`personal-task-toggle quick-add-personal${isPersonal ? ' is-personal' : ''}`} disabled={busy}
          aria-label="新待办是否为个人事项" aria-pressed={isPersonal} title="个人事项不参与日报、周报和月报"
          onClick={() => setIsPersonal((current) => !current)}><Icon name="user" /><span>个人</span></button>
        <button className="quick-add-btn" disabled={busy || !title.trim()} type="submit">{adding ? '保存中' : '添加'}</button>
      </form>
      <span className="panel-footnote">完成后进入日志，忽略事项不计入工作成果</span>
    </section>
  )
})
