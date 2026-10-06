import type { Task } from '../src/domain/workbench.js'
import type { DailyReport } from './contracts.js'
import { recordTimestamp } from '../src/domain/workbench.js'

// 只跟踪实际参与日报的字段；来源证据追加但简介未变化时无需重复整理。
export function reportRecordVersion(task: Task): string {
  return JSON.stringify([task.title, task.projectPath ?? '', Boolean(task.completedAt), recordTimestamp(task), ...(task.evidenceStale ? ['来源已变更'] : [])])
}

export function isRecordInReport(task: Task, report: DailyReport | null | undefined): boolean {
  return !task.isPersonal && report?.recordVersions[task.id] === reportRecordVersion(task)
}

// 混合摘要可能含有私人内容，整项移除并让其中的工作记录重新进入待整理。
export function excludePersonalReportItems(report: DailyReport, personalIds: ReadonlySet<string>): DailyReport {
  const affected = report.items.filter((item) => item.taskIds.some((id) => personalIds.has(id)))
  if (!affected.length && !Object.keys(report.recordVersions).some((id) => personalIds.has(id))) return report
  const removedIds = new Set([...Object.keys(report.recordVersions).filter((id) => personalIds.has(id)), ...affected.flatMap((item) => item.taskIds)])
  const items = report.items.filter((item) => !item.taskIds.some((id) => personalIds.has(id)))
  return { ...report, items, recordCount: new Set(items.flatMap((item) => item.taskIds)).size,
    recordVersions: Object.fromEntries(Object.entries(report.recordVersions).filter(([id]) => !removedIds.has(id))) }
}

export function mergeDailyReports(current: DailyReport[], updates: DailyReport[]): DailyReport[] {
  const reports = new Map(current.map((report) => [report.day, report]))
  for (const report of updates) {
    if ((reports.get(report.day)?.revision ?? 0) <= report.revision) reports.set(report.day, report)
  }
  return [...reports.values()].sort((a, b) => b.day.localeCompare(a.day))
}
