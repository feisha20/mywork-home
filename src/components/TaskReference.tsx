import type { Task } from '../domain/workbench'

export function TaskReference({ task }: { task: Task }) {
  if (task.management) {
    const url = task.management.entities[0]?.url
    return <a className="daily-log-reference zentao-reference" href={url && /^https?:\/\//.test(url) ? url : undefined}
      target="_blank" rel="noopener noreferrer" title="在禅道中查看关联对象">{task.reference}</a>
  }
  if (task.source === 'zentao' && task.zentao?.url && /^https?:\/\//.test(task.zentao.url)) {
    return <a className="daily-log-reference zentao-reference" href={task.zentao.url} target="_blank" rel="noopener noreferrer" title="在禅道中查看并处理事项">{task.reference}</a>
  }
  return <span className="daily-log-reference">{task.reference}</span>
}

const states: Record<string, string> = { active: '待处理', resolved: '待验证', wait: '未开始', doing: '进行中', pause: '已暂停', done: '已完成', closed: '已关闭', cancel: '已取消' }
export function ZentaoTaskDetails({ task }: { task: Task }) {
  if (task.source !== 'zentao' || !task.zentao) return null
  const details = [states[task.zentao.status], task.zentao.project, task.zentao.priority ? `优先级 ${task.zentao.priority}` : '', task.zentao.deadline ? `截止 ${task.zentao.deadline}` : ''].filter(Boolean)
  return <p className="zentao-task-details">{details.join(' · ')}</p>
}
