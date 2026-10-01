import type { RefObject } from 'react'
import { motion } from 'motion/react'
import { dateFromKey, recordsForDate, SOURCES } from '../domain/workbench'
import type { WorkbenchState } from '../domain/workbench'
import { Icon } from './Icon'

interface DailyLogBookProps {
  state: WorkbenchState
  days: string[]
  today: string
  selectedDay: string
  onSelectDay: (day: string) => void
  deckRef: RefObject<HTMLDivElement | null>
  recentId: string | null
}

function shortLabel(day: string, today: string) {
  if (day === today) return '今日'
  const yesterday = dateFromKey(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dateFromKey(day).getTime() === yesterday.getTime()) return '昨日'
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(dateFromKey(day))
}

const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
const logTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

export function DailyLogBook({ state, days, today, selectedDay, onSelectDay, deckRef, recentId }: DailyLogBookProps) {
  const selectedIndex = Math.max(0, days.indexOf(selectedDay))
  const count = recordsForDate(state, selectedDay).length
  return (
    <section className="dashboard-panel daily-panel" aria-labelledby="daily-heading">
      <div className="panel-kicker">02 / 每日沉淀</div>
      <div className="panel-header">
        <h2 id="daily-heading"><Icon name="book" />工作日报</h2>
        <span className="tech-badge">{selectedDay === today ? '今日' : selectedDay.slice(5)} {count} 项已完成</span>
      </div>
      <p className="panel-description">每一次完成，都留下可回看的工作记录。</p>
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
                        <span className="daily-log-source">{SOURCES[task.source].label}</span>
                        <time className="daily-log-time" dateTime={task.completedAt!}>{logTime.format(new Date(task.completedAt!))}</time>
                      </div>
                      <p className="daily-log-text">{task.title}</p>
                      <span className="daily-log-reference">{task.reference}</span>
                    </motion.article>
                  ))}
                  {records.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="book" /></span><h3>今天的记录，等你写下</h3><p>完成一项待办后，它会出现在这里。</p></div>}
                </div>
                <span className="page-bottom-mark" aria-hidden="true">我的工作台 · {day.replaceAll('-', '.')}</span>
              </div>
            )
          })}
        </div>
        <div className="book-controls">
          <button className="page-turn-btn" disabled={selectedIndex >= days.length - 1} onClick={() => onSelectDay(days[selectedIndex + 1])}><Icon name="chevron-left" /><span>查看更早</span></button>
          <span className="page-counter">{selectedIndex + 1} / {days.length}</span>
          <button className="page-turn-btn" disabled={selectedIndex === 0} onClick={() => onSelectDay(days[selectedIndex - 1])}><span>查看较新</span><Icon name="chevron-right" /></button>
        </div>
      </div>
    </section>
  )
}
