import { recordTimestamp } from './workbench'
import type { Task } from './workbench'

export type CaptureDestination = 'tasks' | 'logs'

function captureSignature(task: Task): string {
  return JSON.stringify([task.source, task.title, recordTimestamp(task), task.evidence?.map((entry) => entry.messageId)])
}

// 首次加载不回放历史；只有采集记录实际新增或改变时才显示归档流向。
export function changedCaptureDestinations(previous: Task[] | null, next: Task[]): CaptureDestination[] {
  if (!previous) return []
  const before = new Map(previous.map((task) => [task.id, captureSignature(task)]))
  const destinations = new Set<CaptureDestination>()
  for (const task of next) {
    if (task.source === 'manual' || before.get(task.id) === captureSignature(task)) continue
    destinations.add(recordTimestamp(task) ? 'logs' : 'tasks')
  }
  return [...destinations]
}
