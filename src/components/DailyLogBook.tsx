import type { RefObject } from 'react'
import { motion } from 'motion/react'
import { dateFromKey, recordsForDate, SOURCES } from '../domain/workbench'
import type { Task, WorkbenchState } from '../domain/workbench'
import { Icon } from './Icon'
import { TaskEvidence } from './TaskEvidence'

interface DailyLogBookProps {
  state: WorkbenchState
  days: string[]
  today: string
  selectedDay: string
  onSelectDay: (day: string) => void
  deckRef: RefObject<HTMLDivElement | null>
  recentId: string | null
  onReopen: (task: Task) => void
  disabled: boolean
}

function shortLabel(day: string, today: string) {
  if (day === today) return '今日'
  const yesterday = dateFromKey(today)
  yesterday.setTime(yesterday.getTime() - 86400000)
  if (dateFromKey(day).getTime() === yesterday.getTime()) return '昨日'
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(dateFromKey(day))
}

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
const logTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

export function DailyLogBook({ state, days, today, selectedDay, onSelectDay, deckRef, recentId, onReopen, disabled }: DailyLogBookProps) {
  const selectedIndex = Math.max(0, days.indexOf(selectedDay))
  return (
    <section className="dashboard-panel daily-panel" aria-labelledby="daily-heading">
      <div className="panel-header">
        <h2 id="daily-heading"><Icon name="book" />工作日志</h2>
      </div>
      <div className="book-wrapper">
        <nav className="day-selector-strip" aria-label="日报日期">
          {[...days].reverse().map((day) => (
            <button
              className={`day-pill${day === selectedDay ? ' active' : ''}`}
              key={day}
              onClick={() => onSelectDay(day)}
              aria-pressed={day === selectedDay}
              aria-label={`查看 ${fullDate.format(dateFromKey(day))}的日报`}
            >
              <span>{shortLabel(day, today)}</span>
              <small>{day.slice(5)}</small>
            </button>
          ))}
        </nav>
        <div className="book-deck" ref={deckRef}>
          <div className="book-spine-shadow" aria-hidden="true" />
          {days.map((day, index) => {
            const active = day === selectedDay
            const records = recordsForDate(state, day)
            return (
              <div
                className={`book-page${index < selectedIndex ? ' flipped' : ''}${active ? ' current-page' : ''}`}
                key={day}
                style={{ zIndex: days.length - index + 1 }}
                aria-hidden={!active}
                inert={!active}
                aria-label={`${fullDate.format(dateFromKey(day))}的工作记录`}
              >
                <div className="page-header">
                  <time className="page-date" dateTime={day}>{fullDate.format(dateFromKey(day))}</time>
                  <span className={`page-sign${day !== today ? ' archived' : ''}`}>{day === today ? '● 进行中' : '✓ 已记录'}</span>
                </div>
                <div className="daily-item-list">
                  {records.map((task) => (
                    <motion.article
                      key={task.id}
                      initial={task.id === recentId ? { opacity: 0, y: -12, scale: 0.96 } : false}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ duration: 0.4 }}
                      className={`daily-log-card${task.id === recentId ? ' just-arrived' : ''}`}
                    >
                      <div className="daily-log-top">
                        <div className="daily-log-source-group">
                          <span className="daily-log-source">{SOURCES[task.source].label}</span>
                          <span className="daily-log-reference">{task.reference}</span>
                        </div>
                        <time className="daily-log-time" dateTime={task.completedAt!}>{logTime.format(new Date(task.completedAt!))}</time>
                      </div>
                      <p className="daily-log-text" title={task.title}>{task.title}</p>
                      <div className="daily-log-actions">
                        <TaskEvidence task={task} />
                        <button className="reopen-task" disabled={disabled} onClick={() => onReopen(task)} aria-label={`恢复为待办：${task.title}`}>恢复待办</button>
                      </div>
                    </motion.article>
                  ))}
                  {records.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="book" /></span><h3>今天的记录，等你写下</h3><p>完成一项待办后，它会出现在这里。</p></div>}
                </div>
                <span className="page-bottom-mark" aria-hidden="true">我的工作台 · {day.replaceAll('-', '.')}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
