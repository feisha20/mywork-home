import type { Task } from '../src/domain/workbench.js'
import type { DailyReport } from './contracts.js'
import { recordTimestamp } from '../src/domain/workbench.js'

// 只跟踪实际参与日报的字段；来源证据追加但简介未变化时无需重复整理。
export function reportRecordVersion(task: Task): string {
  return JSON.stringify([task.title, task.projectPath ?? '', Boolean(task.completedAt), recordTimestamp(task)])
}

export function isRecordInReport(task: Task, report: DailyReport | null | undefined): boolean {
  return report?.recordVersions[task.id] === reportRecordVersion(task)
}

export function mergeDailyReports(current: DailyReport[], updates: DailyReport[]): DailyReport[] {
  const reports = new Map(current.map((report) => [report.day, report]))
  for (const report of updates) {
    if ((reports.get(report.day)?.revision ?? 0) <= report.revision) reports.set(report.day, report)
  }
  return [...reports.values()].sort((a, b) => b.day.localeCompare(a.day))
}
