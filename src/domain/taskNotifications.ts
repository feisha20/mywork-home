import { isPendingTask, type Task } from './workbench'

// 单次页面会话以首次快照为基线；状态更新和重复刷新不会再次提醒。
export function createTaskNotificationTracker() {
  let initialized = false
  const seen = new Set<string>()
  return (tasks: readonly Task[]): Task[] => {
    const incoming = tasks.filter((task) => isPendingTask(task)
      && (task.source === 'zentao' || !!task.scheduledPlan))
    const fresh = initialized ? incoming.filter((task) => !seen.has(task.id)) : []
    for (const task of incoming) seen.add(task.id)
    initialized = true
    return fresh
  }
}
