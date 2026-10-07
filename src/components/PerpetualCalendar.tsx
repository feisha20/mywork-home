import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { calendarDays, shiftMonth, shiftYear } from '../domain/calendar'
import { getLunarDate } from '../domain/lunar'
import { dateFromKey } from '../domain/workbench'
import { Icon } from './Icon'

interface PerpetualCalendarProps {
  today: string
  clock: Date
}

const headerDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'long',
  day: 'numeric',
  weekday: 'long'
})

const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long'
})

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0)
  const diff = date.getTime() - start.getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function getWeekNumber(date: Date): number {
  const target = new Date(date.valueOf())
  const dayNr = (date.getDay() + 6) % 7
  target.setDate(target.getDate() - dayNr + 3)
  const firstThursday = target.valueOf()
  target.setMonth(0, 1)
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7)
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000)
}

export function PerpetualCalendar({ today, clock }: PerpetualCalendarProps) {
  const [open, setOpen] = useState(false)
  const [selectedDay, setSelectedDay] = useState(today)
  const [month, setMonth] = useState(() => today.slice(0, 7))

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const popupId = useId()

  // 同步外部 today
  useEffect(() => {
    if (!open) {
      setSelectedDay(today)
      setMonth(today.slice(0, 7))
    }
  }, [today, open])

  // 处理关闭与外部点击
  useEffect(() => {
    if (!open) return
    const handleOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', handleOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handleOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const [yearStr, monthNumStr] = month.split('-')
  const year = parseInt(yearStr, 10)
  const monthNum = parseInt(monthNumStr, 10)

  const days = useMemo(() => calendarDays(month), [month])

  const selectedDateObj = useMemo(() => dateFromKey(selectedDay), [selectedDay])
  const selectedLunar = useMemo(() => getLunarDate(selectedDay), [selectedDay])
  const selectedDayOfYear = useMemo(() => getDayOfYear(selectedDateObj), [selectedDateObj])
  const selectedWeekNumber = useMemo(() => getWeekNumber(selectedDateObj), [selectedDateObj])

  const handleSelectDay = (day: string) => {
    setSelectedDay(day)
    if (!day.startsWith(month)) {
      setMonth(day.slice(0, 7))
    }
  }

  const handleGoToday = () => {
    setSelectedDay(today)
    setMonth(today.slice(0, 7))
  }

  return (
    <div className="header-calendar-wrap" ref={rootRef}>
      <button
        type="button"
        className={`header-date-trigger${open ? ' is-active' : ''}`}
        ref={triggerRef}
        onClick={() => {
          if (!open) {
            setMonth(selectedDay.slice(0, 7))
          }
          setOpen(!open)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popupId : undefined}
        aria-label={`当前日期：${headerDateFormatter.format(clock)}，点击查看万年历`}
        title="点击查看万年历"
      >
        <span className="header-calendar-icon" aria-hidden="true">
          <Icon name="calendar" />
        </span>
        <time className="header-date" dateTime={today}>
          {headerDateFormatter.format(clock)}
        </time>
        <span className="header-date-arrow" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>

      {open && (
        <div
          id={popupId}
          className="perpetual-calendar-popup"
          role="dialog"
          aria-label="万年历"
          ref={popupRef}
        >
          {/* 选中日期详情横幅 */}
          <div className="perpetual-hero">
            <div className="perpetual-hero-info">
              <div className="perpetual-hero-solar">
                <strong>{fullDateFormatter.format(selectedDateObj)}</strong>
                {selectedDay === today && <span className="today-badge">今日</span>}
              </div>
              <div className="perpetual-hero-lunar">
                <span>{selectedLunar.fullLunarString}</span>
                {(selectedLunar.lunarFestival || selectedLunar.solarFestival || selectedLunar.solarTerm) && (
                  <span className="festival-tag">
                    {selectedLunar.lunarFestival || selectedLunar.solarFestival || selectedLunar.solarTerm}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="perpetual-close-button"
              aria-label="关闭万年历"
              onClick={() => {
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <Icon name="close" />
            </button>
          </div>

          {/* 年月翻页切换器 */}
          <div className="perpetual-nav">
            <div className="perpetual-nav-group">
              <button
                type="button"
                className="nav-btn"
                title="上一年"
                aria-label="上一年"
                onClick={() => setMonth(shiftYear(month, -1))}
              >
                <Icon name="chevrons-left" />
              </button>
              <button
                type="button"
                className="nav-btn"
                title="上一月"
                aria-label="上一月"
                onClick={() => setMonth(shiftMonth(month, -1))}
              >
                <Icon name="chevron-left" />
              </button>
            </div>

            <div className="perpetual-current-label">
              <strong>{year} 年 {monthNum} 月</strong>
            </div>

            <div className="perpetual-nav-group">
              <button
                type="button"
                className="nav-btn"
                title="下一月"
                aria-label="下一月"
                onClick={() => setMonth(shiftMonth(month, 1))}
              >
                <Icon name="chevron-right" />
              </button>
              <button
                type="button"
                className="nav-btn"
                title="下一年"
                aria-label="下一年"
                onClick={() => setMonth(shiftYear(month, 1))}
              >
                <Icon name="chevrons-right" />
              </button>
            </div>
          </div>

          {/* 星期行 */}
          <div className="perpetual-weekdays" aria-hidden="true">
            {['一', '二', '三', '四', '五', '六', '日'].map((w, idx) => (
              <span key={w} className={idx >= 5 ? 'is-weekend' : undefined}>{w}</span>
            ))}
          </div>

          {/* 42天网格 */}
          <div className="perpetual-grid" role="group" aria-label="万年历日期">
            {days.map((day, idx) => {
              const inMonth = day.startsWith(month)
              const isSelected = day === selectedDay
              const isToday = day === today
              const isWeekend = idx % 7 >= 5
              const lunar = getLunarDate(day)

              return (
                <button
                  key={day}
                  type="button"
                  className={`perpetual-cell${inMonth ? ' in-month' : ' outside-month'}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${isWeekend ? ' is-weekend' : ''}`}
                  onClick={() => handleSelectDay(day)}
                  aria-pressed={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={`${day}，${lunar.fullLunarString}${lunar.solarFestival ? `，${lunar.solarFestival}` : ''}${lunar.solarTerm ? `，${lunar.solarTerm}` : ''}`}
                >
                  <span className="solar-num">{parseInt(day.slice(8), 10)}</span>
                  <span className={`lunar-tag tag-${lunar.tagType}`}>{lunar.displayTag}</span>
                </button>
              )
            })}
          </div>

          {/* 底部小工具条 */}
          <div className="perpetual-footer">
            <span className="perpetual-stats">
              第 {selectedWeekNumber} 周 · 全年第 {selectedDayOfYear} 天
            </span>
            <button
              type="button"
              className="perpetual-today-button"
              onClick={handleGoToday}
              disabled={selectedDay === today && month === today.slice(0, 7)}
            >
              返回今天
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
