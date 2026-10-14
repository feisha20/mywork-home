import type { DailyReport } from '../../shared/contracts'
import { dailyReportItemDisplay } from '../../shared/dailyReports'
import { dateFromKey } from './workbench'

const reportDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' })

export function dailyReportTitle(day: string): string {
  return `工作日报｜${reportDate.format(dateFromKey(day))}`
}

export function dailyReportText(report: DailyReport): string {
  const items = report.items.map((item, index) => {
    const display = dailyReportItemDisplay(item)
    return display ? `${index + 1}. ${display.heading}\n${display.subItems.map((text) => `   - ${text}`).join('\n')}` : `${index + 1}. ${item.text}`
  })
  return `${dailyReportTitle(report.day)}\n\n${items.join('\n')}`
}
