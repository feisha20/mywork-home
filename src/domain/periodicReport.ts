import type { DailyReport } from '../../shared/contracts.js'
import { excludePersonalReportItems } from '../../shared/dailyReports.js'
import { dateFromKey, dateKey, recordTimestamp, type Task } from './workbench.js'

export interface WeekBounds {
  weekKey: string
  year: number
  weekNumber: number
  startDate: string
  endDate: string
  label: string
}

export interface MonthBounds {
  monthKey: string
  year: number
  monthNumber: number
  startDate: string
  endDate: string
  label: string
}

export interface PeriodStats {
  totalDays: number
  reportedDays: number
  totalTasks: number
  completedTasks: number
  projectCount: number
}

export interface AggregatedPeriodData {
  startDate: string
  endDate: string
  matchedReports: DailyReport[]
  completedTasks: Task[]
  pendingTasks: Task[]
  stats: PeriodStats
  projects: string[]
}

export interface PeriodicReportSection {
  title: string
  items: string[]
}

export interface PeriodicReportModel {
  id: string
  type: 'weekly' | 'monthly'
  periodKey: string
  title: string
  startDate: string
  endDate: string
  generatedAt: string
  sections: PeriodicReportSection[]
  markdown: string
  stats: PeriodStats
  revision: number
  edited: boolean
  needsRefresh?: boolean
  mcpMaterialFingerprint?: string
}

function pad(num: number): string {
  return String(num).padStart(2, '0')
}

// 所有周期边界都以北京时间日期计算，不依赖浏览器或容器的本地时区。
function calendarDate(date: Date): Date { return new Date(`${dateKey(date)}T12:00:00Z`) }
export function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10)
}
export function getISOWeek(date: Date): { year: number; weekNumber: number } {
  const d = calendarDate(date)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const year = d.getUTCFullYear()
  return { year, weekNumber: Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7) }
}
export function getWeekBounds(date: Date): WeekBounds {
  const d = calendarDate(date), day = d.getUTCDay() || 7
  const startDate = shiftDay(dateKey(date), 1 - day), endDate = shiftDay(startDate, 6)
  const { year, weekNumber } = getISOWeek(dateFromKey(startDate))
  return { weekKey: `${year}-W${pad(weekNumber)}`, year, weekNumber, startDate, endDate,
    label: `${year}年第${weekNumber}周 (${startDate.slice(5).replace('-', '.')} - ${endDate.slice(5).replace('-', '.')})` }
}
export function getMonthBounds(date: Date): MonthBounds {
  const d = calendarDate(date), year = d.getUTCFullYear(), monthNumber = d.getUTCMonth() + 1
  const monthKey = `${year}-${pad(monthNumber)}`
  const endDate = new Date(Date.UTC(year, monthNumber, 0, 12)).toISOString().slice(0, 10)
  return { monthKey, year, monthNumber, startDate: `${monthKey}-01`, endDate, label: `${year}年${pad(monthNumber)}月` }
}
export function listRecentWeeks(referenceDate: Date, count = 8): (WeekBounds & { isCurrent: boolean })[] {
  const current = getWeekBounds(referenceDate)
  return Array.from({ length: count }, (_, i) => {
    const bounds = getWeekBounds(dateFromKey(shiftDay(current.startDate, -i * 7)))
    return { ...bounds, isCurrent: bounds.weekKey === current.weekKey }
  })
}
export function listRecentMonths(referenceDate: Date, count = 6): (MonthBounds & { isCurrent: boolean })[] {
  const current = getMonthBounds(referenceDate)
  return Array.from({ length: count }, (_, i) => {
    const bounds = getMonthBounds(new Date(Date.UTC(current.year, current.monthNumber - 1 - i, 1, 12)))
    return { ...bounds, isCurrent: bounds.monthKey === current.monthKey }
  })
}
export function periodBounds(type: 'weekly' | 'monthly', key: string) {
  if (type === 'monthly' && /^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    const bounds = getMonthBounds(dateFromKey(`${key}-01`))
    return { ...bounds, key: bounds.monthKey }
  }
  const match = /^(\d{4})-W(\d{2})$/.exec(key)
  if (type === 'weekly' && match) {
    const first = getWeekBounds(dateFromKey(`${match[1]}-01-04`))
    const bounds = getWeekBounds(dateFromKey(shiftDay(first.startDate, (Number(match[2]) - 1) * 7)))
    if (bounds.weekKey === key) return { ...bounds, key }
  }
  throw new Error('报告周期无效')
}

export function aggregatePeriodData(
  startDate: string,
  endDate: string,
  reports: DailyReport[],
  tasks: Task[]
): AggregatedPeriodData {
  // 匹配落在该时间区间内的已保存日报
  const personalIds = new Set(tasks.filter((task) => task.isPersonal).map((task) => task.id))
  const matchedReports = reports
    .filter((report) => report.day >= startDate && report.day <= endDate)
    .map((report) => excludePersonalReportItems(report, personalIds))
    .filter((report) => report.items.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day))

  // 匹配任务：已完成任务以记录/完成日期判定，未完成任务在创建时间或记录时间内
  const completedTasks: Task[] = []
  const pendingTasks: Task[] = []
  const projectsSet = new Set<string>()

  for (const task of tasks) {
    if (task.isPersonal) continue
    const time = recordTimestamp(task) ?? task.completedAt ?? task.createdAt
    const taskDay = dateKey(new Date(time))

    if (task.projectPath) {
      const name = task.projectPath.split(/[\\/]/).filter(Boolean).at(-1)
      if (name) projectsSet.add(name)
    }

    if (taskDay >= startDate && taskDay <= endDate) {
      if (task.completedAt) completedTasks.push(task)
      else pendingTasks.push(task)
    } else if (!task.completedAt && taskDay <= endDate) {
      // 只要在周期结束前创建且至今未完成的待办，也算作持续推进中待办
      pendingTasks.push(task)
    }
  }

  const startD = dateFromKey(startDate)
  const endD = dateFromKey(endDate)
  const totalDays = Math.max(1, Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1)

  return {
    startDate,
    endDate,
    matchedReports,
    completedTasks,
    pendingTasks,
    stats: {
      totalDays,
      reportedDays: matchedReports.length,
      totalTasks: completedTasks.length + pendingTasks.length,
      completedTasks: completedTasks.length,
      projectCount: projectsSet.size,
    },
    projects: Array.from(projectsSet),
  }
}

export function synthesizePeriodicReport(
  type: 'weekly' | 'monthly',
  bounds: { label: string; startDate: string; endDate: string; key?: string },
  reports: DailyReport[],
  tasks: Task[]
): PeriodicReportModel {
  const aggregated = aggregatePeriodData(bounds.startDate, bounds.endDate, reports, tasks)
  const isWeekly = type === 'weekly'
  const typeName = isWeekly ? '周报' : '月报'
  const title = `${bounds.label}工作${typeName}`

  // 1. 核心进展提取与去重归纳
  const coreOutputs: string[] = []
  const seenTexts = new Set<string>()

  // 优先从已整理好的日报中抽取精炼总结
  for (const report of aggregated.matchedReports) {
    for (const item of report.items) {
      const trimmed = item.text.trim()
      if (trimmed && !seenTexts.has(trimmed)) {
        seenTexts.add(trimmed)
        const prefix = item.topic ? `【${item.topic}】` : ''
        coreOutputs.push(`${prefix}${trimmed}`)
      }
    }
  }

  // 若无日报但有完成的任务，补充任务标题
  if (coreOutputs.length === 0 && aggregated.completedTasks.length > 0) {
    for (const task of aggregated.completedTasks.slice(0, 10)) {
      if (!seenTexts.has(task.title)) {
        seenTexts.add(task.title)
        coreOutputs.push(task.title)
      }
    }
  }

  if (coreOutputs.length === 0) {
    coreOutputs.push(`本${isWeekly ? '周' : '月'}暂无已归档的工作记录。`)
  }

  // 2. 推进中事项与关注点
  const inProgress: string[] = []
  for (const task of aggregated.pendingTasks.slice(0, 6)) {
    inProgress.push(`持续推进：${task.title}`)
  }
  if (inProgress.length === 0) {
    inProgress.push(`当前无阻塞事项，既定任务推进正常。`)
  }

  // 3. 下阶段工作计划
  const nextPlan: string[] = []
  if (aggregated.pendingTasks.length > 0) {
    for (const task of aggregated.pendingTasks.slice(0, 5)) {
      nextPlan.push(`优先落地并交付：${task.title}`)
    }
  }
  if (nextPlan.length === 0) {
    nextPlan.push(`根据项目整体里程碑安排推进后续需求与迭代计划。`)
  }

  const sections: PeriodicReportSection[] = [
    {
      title: isWeekly ? '一、 本周核心工作成果与进展' : '一、 本月主要交付成果与里程碑',
      items: coreOutputs,
    },
    {
      title: isWeekly ? '二、 推进中工作与风险关注' : '二、 持续推进中的重点专项',
      items: inProgress,
    },
    {
      title: isWeekly ? '三、 下周工作计划' : '三、 下月重点工作规划',
      items: nextPlan,
    },
  ]

  // 生成标准的 Markdown
  const markdownLines: string[] = [
    `# ${title}`,
    `> 周期统计：${aggregated.stats.reportedDays}/${aggregated.stats.totalDays} 天记录 | 累计已完成 ${aggregated.stats.completedTasks} 项工作 | 涉及 ${aggregated.stats.projectCount} 个项目`,
    '',
  ]

  for (const section of sections) {
    markdownLines.push(`### ${section.title}`)
    section.items.forEach((item, index) => {
      markdownLines.push(`${index + 1}. ${item}`)
    })
    markdownLines.push('')
  }

  const markdown = markdownLines.join('\n').trim()

  return {
    id: `${type}-${bounds.key ?? (isWeekly ? getWeekBounds(dateFromKey(bounds.startDate)).weekKey : getMonthBounds(dateFromKey(bounds.startDate)).monthKey)}`,
    type,
    periodKey: bounds.key ?? (isWeekly ? getWeekBounds(dateFromKey(bounds.startDate)).weekKey : getMonthBounds(dateFromKey(bounds.startDate)).monthKey),
    title,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    generatedAt: new Date().toISOString(),
    sections,
    markdown,
    stats: aggregated.stats,
    revision: 0, edited: false,
  }
}

// Markdown 是编辑后的唯一正文，结构化段落由同一正文恢复，避免两份内容分叉。
export function periodicMarkdownSections(markdown: string): PeriodicReportSection[] {
  const sections: PeriodicReportSection[] = []
  let current: PeriodicReportSection | undefined
  const hasSections = /^#{3,6}\s+/m.test(markdown)
  for (const line of markdown.split('\n')) {
    if (!line.trim()) continue
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (hasSections && /^#{1,2}\s+/.test(line)) continue
    if (heading) { current = { title: heading[1],items: [] }; sections.push(current); continue }
    if (!current && hasSections) continue
    if (!current) { current = { title:'正文',items: [] }; sections.push(current) }
    current.items.push(line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, ''))
  }
  return sections
}
