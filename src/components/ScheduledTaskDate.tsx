import type { Task } from '../domain/workbench'
import { dateKey } from '../domain/workbench'

const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' })
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

// 计划日期随每条已生成待办保存，修改或删除计划后仍能辨认原来的归属日期。
export function ScheduledTaskDate({ task }: { task: Task }) {
  if (!task.scheduledPlan) return null
  const planned = new Date(task.scheduledPlan.scheduledAt)
  const day = dateKey(planned)
  const completed = task.completedAt ? new Date(task.completedAt) : null
  return <p className="scheduled-task-date">
    <span>归属日期：<time dateTime={task.scheduledPlan.scheduledAt}>{day}（{weekday.format(planned)}）</time></span>
    <span> · 计划 {time.format(planned)}</span>
    {completed && dateKey(completed) !== day && <span> · 实际完成：<time dateTime={task.completedAt!}>{dateKey(completed)} {time.format(completed)}</time></span>}
  </p>
}
