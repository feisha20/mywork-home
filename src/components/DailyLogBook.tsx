import { memo, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { dateFromKey, dateKey, recordTimestamp, recordsForDate } from '../domain/workbench'
import type { Task, WorkbenchState } from '../domain/workbench'
import { Icon } from './Icon'
import { LogCalendar } from './LogCalendar'
import { LogHistoryDialog } from './LogHistoryDialog'
import { LogRecords } from './LogRecords'

interface DailyLogBookProps {
  state: WorkbenchState
  today: string
  deckRef: RefObject<HTMLDivElement | null>
  recentId: string | null
  onReopen: (task: Task) => void
  disabled: boolean
}

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
const headerDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' })

export const DailyLogBook = memo(function DailyLogBook({ state, today, deckRef, recentId, onReopen, disabled }: DailyLogBookProps) {
  const [historyDay, setHistoryDay] = useState<string | null>(null)
  const records = useMemo(() => recordsForDate(state, today), [state, today])
  const historyRecords = useMemo(() => historyDay ? recordsForDate(state, historyDay) : [], [state, historyDay])
  const recordedDays = useMemo(() => new Set(state.tasks.flatMap((task) => { const time = recordTimestamp(task); return time ? [dateKey(new Date(time))] : [] })), [state.tasks])
  return (
    <section className="dashboard-panel daily-panel" aria-labelledby="daily-heading">
      <div className="panel-header">
        <h2 id="daily-heading"><Icon name="book" />工作日志 <time className="log-heading-date" dateTime={today} title={fullDate.format(dateFromKey(today))}>{headerDate.format(dateFromKey(today))}</time></h2>
        <LogCalendar selectedDay={historyDay ?? today} today={today} recordedDays={recordedDays} onSelectDay={setHistoryDay} />
      </div>
      <div className="book-wrapper">
        <div className="book-deck" ref={deckRef}>
          <div className="book-spine-shadow" aria-hidden="true" />
          <div className="book-page current-page" key={today} aria-label={`${fullDate.format(dateFromKey(today))}的工作记录`}>
            <LogRecords records={records} recentId={recentId} onReopen={onReopen} disabled={disabled} />
          </div>
        </div>
      </div>
      {historyDay && <LogHistoryDialog day={historyDay} records={historyRecords} onReopen={onReopen} disabled={disabled} onClose={() => setHistoryDay(null)} />}
    </section>
  )
})
