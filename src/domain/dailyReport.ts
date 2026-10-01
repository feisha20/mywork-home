import type { DailyReport } from '../../shared/contracts'
import { dateFromKey } from './workbench'

const reportDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' })

export function dailyReportTitle(day: string): string {
  return `工作日报｜${reportDate.format(dateFromKey(day))}`
}

export function dailyReportText(report: DailyReport): string {
  return `${dailyReportTitle(report.day)}\n\n${report.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`
}
