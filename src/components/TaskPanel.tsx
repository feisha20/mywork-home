import { useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { SOURCES } from '../domain/workbench'
import type { Task } from '../domain/workbench'
import { Icon } from './Icon'

interface TaskPanelProps {
  tasks: Task[]
  panelRef: RefObject<HTMLElement | null>
  activeId: string | null
  onAdd: (title: string) => void
  onComplete: (task: Task, button: HTMLButtonElement) => void
}

export function TaskPanel({ tasks, panelRef, activeId, onAdd, onComplete }: TaskPanelProps) {
  const [title, setTitle] = useState('')
  const busy = activeId !== null
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim() || busy) return
    onAdd(title)
    setTitle('')
  }

  return (
    <section className="dashboard-panel task-panel" ref={panelRef} aria-labelledby="tasks-heading">
      <div className="panel-kicker">01 / 工作输入</div>
      <div className="panel-header">
        <h2 id="tasks-heading"><Icon name="list" />待办事项清单</h2>
        <span className="tech-badge">{tasks.length} 项待处理</span>
      </div>
      <p className="panel-description">从一件小事开始，让今天的工作向前一步。</p>

      <div className="task-container" aria-label="待办事项">
        <AnimatePresence mode="popLayout" initial={false}>
          {tasks.map((task) => (
            <motion.article
              key={task.id}
              layout="position"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, x: 12 }}
              transition={{ duration: 0.25 }}
              className={`task-card${activeId === task.id ? ' is-transferring' : ''}`}
            >
              <div className="task-info">
                <div className="task-tagline">
                  <span className={`source-chip ${SOURCES[task.source].className}`}>{SOURCES[task.source].label}</span>
                  <span className="task-id">{task.reference}</span>
                </div>
                <p className="task-text" title={task.title}>{task.title}</p>
              </div>
              <button
                className="btn-pipe-transfer"
                disabled={busy}
                onClick={(event) => onComplete(task, event.currentTarget)}
                aria-label={`完成任务：${task.title}`}
              >
                <span>{activeId === task.id ? '传输中' : '完成'}</span>
                <Icon name="arrow" />
              </button>
            </motion.article>
          ))}
        </AnimatePresence>
        {tasks.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="check" /></span>
            <h3>待办清空了</h3>
            <p>完成的工作已收进日报。<br />也可以在下方记下下一件事。</p>
          </div>
        )}
      </div>

      <form className="quick-add-box" onSubmit={handleSubmit}>
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
        <button className="quick-add-btn" disabled={busy || !title.trim()} type="submit">添加</button>
      </form>
      <span className="panel-footnote">手动添加的事项也会自动收进日报</span>
    </section>
  )
}
