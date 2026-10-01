import { memo, useMemo } from 'react'
import type { RefObject } from 'react'
import { dateFromKey, dateKey, recordTimestamp, recordsForDate, requiresManualCompletion, SOURCES } from '../domain/workbench'
import type { Task, WorkbenchState } from '../domain/workbench'
import { Icon } from './Icon'
import { TaskEvidence } from './TaskEvidence'
import { LogCalendar } from './LogCalendar'

interface DailyLogBookProps {
  state: WorkbenchState
  today: string
  selectedDay: string
  onSelectDay: (day: string) => void
  deckRef: RefObject<HTMLDivElement | null>
  recentId: string | null
  onReopen: (task: Task) => void
  disabled: boolean
}

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
const logTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

export const DailyLogBook = memo(function DailyLogBook({ state, today, selectedDay, onSelectDay, deckRef, recentId, onReopen, disabled }: DailyLogBookProps) {
  const records = useMemo(() => recordsForDate(state, selectedDay), [state, selectedDay])
  const recordedDays = useMemo(() => new Set(state.tasks.flatMap((task) => { const time = recordTimestamp(task); return time ? [dateKey(new Date(time))] : [] })), [state.tasks])
  return (
    <section className="dashboard-panel daily-panel" aria-labelledby="daily-heading">
      <div className="panel-header">
        <h2 id="daily-heading"><Icon name="book" />工作日志</h2>
        <LogCalendar selectedDay={selectedDay} today={today} recordedDays={recordedDays} onSelectDay={onSelectDay} />
      </div>
      <div className="book-wrapper">
        <div className="book-deck" ref={deckRef}>
          <div className="book-spine-shadow" aria-hidden="true" />
          <div
            className="book-page current-page"
            key={selectedDay}
            aria-label={`${fullDate.format(dateFromKey(selectedDay))}的工作记录`}
          >
            <div className="page-header">
              <time className="page-date" dateTime={selectedDay}>{fullDate.format(dateFromKey(selectedDay))}</time>
              <span className={`page-sign${selectedDay !== today ? ' archived' : ''}`}>{selectedDay === today ? '● 进行中' : '✓ 已记录'}</span>
            </div>
            <div className="daily-item-list">
              {records.map((task) => (
                <article
                  key={task.id}
                  className={`daily-log-card${task.id === recentId ? ' just-arrived' : ''}`}
                >
                  <div className="daily-log-top">
                    <div className="daily-log-source-group">
                      <span className="daily-log-source">{SOURCES[task.source].label}</span>
                      <span className="daily-log-reference">{task.reference}</span>
                    </div>
                    <time className="daily-log-time" dateTime={recordTimestamp(task)!}>{logTime.format(new Date(recordTimestamp(task)!))}</time>
                  </div>
                  <p className="daily-log-text" title={task.title}>{task.title}</p>
                  <div className="daily-log-actions">
                    <TaskEvidence task={task} />
                    {requiresManualCompletion(task.source) && <button className="reopen-task" disabled={disabled} onClick={() => onReopen(task)} aria-label={`恢复为待办：${task.title}`}>恢复待办</button>}
                  </div>
                </article>
              ))}
              {records.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="book" /></span><h3>这一天还没有工作日志</h3><p>同步的工作记录会按来源日期自动归档，待办完成后也会进入日志。</p></div>}
            </div>
            <span className="page-bottom-mark" aria-hidden="true">我的工作台 · {selectedDay.replaceAll('-', '.')}</span>
          </div>
        </div>
      </div>
    </section>
  )
})
