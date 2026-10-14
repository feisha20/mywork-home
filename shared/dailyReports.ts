import { z } from 'zod'
import type { Task } from '../src/domain/workbench.js'
import type { DailyReport, DailyReportItem } from './contracts.js'
import { recordTimestamp } from '../src/domain/workbench.js'

// 单项上限用于防止异常长文；正常篇幅按实际工作量调整，不作为精简目标。
export const dailyReportItemMaxLength = 1200

// text 保留完整工作内容，供原有周月报聚合和历史读取使用。
export function dailyReportItemText(item: { text: string; subItems?: string[] }): string {
  return item.subItems?.length ? item.subItems.join('；') : item.text
}

export const dailyReportItemSchema = z.object({
  text: z.string().trim().min(1),
  taskIds: z.array(z.string().min(1).max(100)).min(1),
  topic: z.string().trim().min(1).max(30).optional(),
  subItems: z.array(z.string().trim().min(1).refine((text) => !/[\r\n]/.test(text), '子项应为一段文字')).min(2).max(50).optional(),
}).strict()
  .refine((item) => dailyReportItemText(item).length <= dailyReportItemMaxLength, `每项日报最多${dailyReportItemMaxLength}个字符，请合并重复表达并保留各项成果`)
  .refine((item) => !/[\r\n]/.test(dailyReportItemText(item)), '每项日报应为一段文字')

// 旧日报仅在已有主题和明确分号分隔时分点显示，不改写保存内容或推断工作。
export function dailyReportItemDisplay(item: DailyReportItem): { heading: string; subItems: string[] } | null {
  if (item.subItems?.length) return { heading: item.topic ?? '工作进展', subItems: item.subItems }
  const separator = item.text.indexOf('：')
  const topic = item.topic ?? (separator > 0 && separator <= 30 ? item.text.slice(0, separator) : undefined)
  if (!topic) return null
  const body = separator > 0 && separator <= 30 ? item.text.slice(separator + 1) : item.text
  const subItems = body.split('；').map((text) => text.trim()).filter(Boolean)
  return subItems.length > 1 ? { heading: topic, subItems } : null
}

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
