import type { DailyReport } from '../../shared/contracts.js'
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
}

function pad(num: number): string {
  return String(num).padStart(2, '0')
}

// 计算 ISO 周数 (周一为一周起点)
export function getISOWeek(date: Date): { year: number; weekNumber: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return { year: d.getUTCFullYear(), weekNumber: weekNo }
}

export function getWeekBounds(date: Date): WeekBounds {
  const current = new Date(date)
  // 获取当前星期几（0是周日，1-6是周一至周六）
  const day = current.getDay()
  // 周一为起点：周日视为偏移 6，其它为 day - 1
  const diffToMonday = day === 0 ? -6 : 1 - day

  const monday = new Date(current)
  monday.setDate(current.getDate() + diffToMonday)

  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const startDate = dateKey(monday)
  const endDate = dateKey(sunday)

  const { year, weekNumber } = getISOWeek(monday)
  const weekKey = `${year}-W${pad(weekNumber)}`

  const startMonthDay = startDate.slice(5).replace('-', '.')
  const endMonthDay = endDate.slice(5).replace('-', '.')
  const label = `${year}年第${weekNumber}周 (${startMonthDay} - ${endMonthDay})`

  return { weekKey, year, weekNumber, startDate, endDate, label }
}

export function getMonthBounds(date: Date): MonthBounds {
  const year = date.getFullYear()
  const monthNumber = date.getMonth() + 1
  const monthKey = `${year}-${pad(monthNumber)}`

  const startDate = `${monthKey}-01`
  const lastDay = new Date(year, monthNumber, 0).getDate()
  const endDate = `${monthKey}-${pad(lastDay)}`
  const label = `${year}年${pad(monthNumber)}月`

  return { monthKey, year, monthNumber, startDate, endDate, label }
}

export function listRecentWeeks(referenceDate: Date, count = 8): (WeekBounds & { isCurrent: boolean })[] {
  const currentBounds = getWeekBounds(referenceDate)
  const list: (WeekBounds & { isCurrent: boolean })[] = []

  for (let i = 0; i < count; i++) {
    const d = new Date(referenceDate)
    d.setDate(d.getDate() - i * 7)
    const bounds = getWeekBounds(d)
    // 避免跨夏令时或极端边界出现重复周 key
    if (!list.some((item) => item.weekKey === bounds.weekKey)) {
      list.push({ ...bounds, isCurrent: bounds.weekKey === currentBounds.weekKey })
    }
  }

  return list
}

export function listRecentMonths(referenceDate: Date, count = 6): (MonthBounds & { isCurrent: boolean })[] {
  const currentBounds = getMonthBounds(referenceDate)
  const list: (MonthBounds & { isCurrent: boolean })[] = []

  for (let i = 0; i < count; i++) {
    const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - i, 1)
    const bounds = getMonthBounds(d)
    list.push({ ...bounds, isCurrent: bounds.monthKey === currentBounds.monthKey })
  }

  return list
}

export function aggregatePeriodData(
  startDate: string,
  endDate: string,
  reports: DailyReport[],
  tasks: Task[]
): AggregatedPeriodData {
  // 匹配落在该时间区间内的已保存日报
  const matchedReports = reports
    .filter((report) => report.day >= startDate && report.day <= endDate)
    .sort((a, b) => a.day.localeCompare(b.day))

  // 匹配任务：已完成任务以记录/完成日期判定，未完成任务在创建时间或记录时间内
  const completedTasks: Task[] = []
  const pendingTasks: Task[] = []
  const projectsSet = new Set<string>()

  for (const task of tasks) {
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
  }
}
