import { useEffect, useRef, useState } from 'react'
import { calendarDays, shiftMonth } from '../domain/calendar'
import { dateFromKey } from '../domain/workbench'
import { Icon } from './Icon'

const label = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full' })
interface LogCalendarProps {
  selectedDay: string
  today: string
  recordedDays: Set<string>
  onSelectDay: (day: string) => void
}

export function LogCalendar({ selectedDay, today, recordedDays, onSelectDay }: LogCalendarProps) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(selectedDay.slice(0, 7))
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const date = popup.current?.querySelector<HTMLButtonElement>('.calendar-date.selected') ?? popup.current?.querySelector<HTMLButtonElement>('.calendar-date.in-month')
    date?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const select = (day: string) => { onSelectDay(day); setOpen(false); trigger.current?.focus() }
  const [year, number] = month.split('-')
  return <div className="log-calendar" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }}>
    <button className={`calendar-trigger${open ? ' active' : ''}`} ref={trigger} aria-label="选择工作日志日期" title="选择日志日期" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? 'log-calendar-popup' : undefined}
      onClick={() => { if (!open) setMonth(selectedDay.slice(0, 7)); setOpen(!open) }}><Icon name="calendar" /></button>
    {open && <div className="calendar-popup" ref={popup} id="log-calendar-popup" role="dialog" aria-label="选择工作日志日期">
      <div className="calendar-month">
        <button aria-label="上个月" onClick={() => setMonth(shiftMonth(month, -1))}><Icon name="chevron-left" /></button>
        <strong aria-live="polite">{year} 年 {Number(number)} 月</strong>
        <button aria-label="下个月" onClick={() => setMonth(shiftMonth(month, 1))}><Icon name="chevron-right" /></button>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="calendar-dates" role="group" aria-label="日历日期">
        {calendarDays(month).map((day) => <button key={day}
          className={`calendar-date${day.startsWith(month) ? ' in-month' : ' outside-month'}${day === selectedDay ? ' selected' : ''}${day === today ? ' today' : ''}${recordedDays.has(day) ? ' has-records' : ''}`}
          aria-label={`${label.format(dateFromKey(day))}${recordedDays.has(day) ? '，有工作日志' : '，暂无日志'}`} aria-pressed={day === selectedDay} aria-current={day === today ? 'date' : undefined}
          onClick={() => select(day)}>{Number(day.slice(8))}</button>)}
      </div>
      <div className="calendar-footer"><span><i />有工作日志</span><button onClick={() => select(today)}>回到今天</button></div>
    </div>}
  </div>
}
