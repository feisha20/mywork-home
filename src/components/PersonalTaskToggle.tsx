import type { Task } from '../domain/workbench'
import { Icon } from './Icon'

interface PersonalTaskToggleProps {
  task: Task
  disabled?: boolean
  onToggle: (task: Task) => Promise<Task>
}

export function PersonalTaskToggle({ task, disabled, onToggle }: PersonalTaskToggleProps) {
  const personal = Boolean(task.isPersonal)
  const automatic = task.personalOrigin === 'ai'
  const action = personal ? '改为工作事项' : '标为个人事项'
  const description = personal ? `${automatic ? 'AI 判定为' : '已标为'}个人事项，不参与日报、周报和月报；点击改为工作事项` : '点击标为个人事项，汇报时将忽略此项'
  return <button type="button" className={`personal-task-toggle${personal ? ' is-personal' : ''}`} disabled={disabled}
    aria-pressed={personal} aria-label={`${action}：${task.title}`} title={description}
    onClick={() => { void onToggle(task).catch(() => {}) }}>
    <Icon name="user" /><span>{personal ? '个人事项' : '标为个人'}</span>
    {personal && automatic && <small>AI</small>}
  </button>
}
