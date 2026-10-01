import { memo, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { dateFromKey, dateKey, recordTimestamp, recordsForDate } from '../domain/workbench'
import type { Task, WorkbenchState } from '../domain/workbench'
import { Icon } from './Icon'
import { LogCalendar } from './LogCalendar'
import { LogHistoryDialog } from './LogHistoryDialog'
import { LogRecords } from './LogRecords'
import { DailyReportDialog } from './DailyReportDialog'
import type { DailyReport } from '../../shared/contracts'

interface DailyLogBookProps {
  state: WorkbenchState
  reports: DailyReport[]
  onReportSaved: (report: DailyReport) => void
  today: string
  deckRef: RefObject<HTMLDivElement | null>
  recentId: string | null
  onReopen: (task: Task) => void
  disabled: boolean
}

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
const headerDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' })

export const DailyLogBook = memo(function DailyLogBook({ state, reports, onReportSaved, today, deckRef, recentId, onReopen, disabled }: DailyLogBookProps) {
  const [historyDay, setHistoryDay] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const records = useMemo(() => recordsForDate(state, today), [state, today])
  const historyRecords = useMemo(() => historyDay ? recordsForDate(state, historyDay) : [], [state, historyDay])
  const todayReport = reports.find((report) => report.day === today) ?? null
  const historyReport = reports.find((report) => report.day === historyDay) ?? null
  const recordedDays = useMemo(() => new Set(state.tasks.flatMap((task) => { const time = recordTimestamp(task); return time ? [dateKey(new Date(time))] : [] })), [state.tasks])
  return (
    <section className="dashboard-panel daily-panel" aria-labelledby="daily-heading">
      <div className="panel-header">
        <h2 id="daily-heading"><Icon name="book" />工作日志 <time className="log-heading-date" dateTime={today} title={fullDate.format(dateFromKey(today))}>{headerDate.format(dateFromKey(today))}</time></h2>
        <div className="log-header-actions">
          <button className="report-button report-generate" disabled={disabled || (!records.length && !todayReport)} title={todayReport ? '查看已保存日报，可补充整理待整理的记录' : records.length ? '归类总结今日工作日志' : '有工作日志后即可生成日报'} onClick={() => setReportOpen(true)}><Icon name="list" />{todayReport ? '查看日报' : '生成日报'}</button>
          <LogCalendar selectedDay={historyDay ?? today} today={today} recordedDays={recordedDays} onSelectDay={setHistoryDay} />
        </div>
      </div>
      <div className="book-wrapper">
        <div className="book-deck" ref={deckRef}>
          <div className="book-spine-shadow" aria-hidden="true" />
          <div className="book-page current-page" key={today} aria-label={`${fullDate.format(dateFromKey(today))}的工作记录`}>
            <LogRecords records={records} dailyReport={todayReport} recentId={recentId} onReopen={onReopen} disabled={disabled} />
          </div>
        </div>
      </div>
      {historyDay && <LogHistoryDialog day={historyDay} records={historyRecords} dailyReport={historyReport} onReportSaved={onReportSaved} onReopen={onReopen} disabled={disabled} onClose={() => setHistoryDay(null)} />}
      {reportOpen && <DailyReportDialog key={today} day={today} records={records} savedReport={todayReport} onSaved={onReportSaved} onClose={() => setReportOpen(false)} />}
    </section>
  )
})
