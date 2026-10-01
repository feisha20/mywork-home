import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dateFromKey } from '../domain/workbench'
import { Icon } from './Icon'
import { LogRecords } from './LogRecords'
import type { LogRecordsProps } from './LogRecords'
import { DailyReportDialog } from './DailyReportDialog'
import type { DailyReport } from '../../shared/contracts'

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
interface LogHistoryDialogProps extends LogRecordsProps {
  day: string
  onReportSaved: (report: DailyReport) => void
  onClose: () => void
}

export function LogHistoryDialog({ day, onReportSaved, onClose, ...recordsProps }: LogHistoryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [reportOpen, setReportOpen] = useState(false)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      if (trigger?.isConnected) trigger.focus()
    }
  }, [])
  return createPortal(<dialog className="log-history-dialog" ref={dialogRef} aria-labelledby="log-history-heading" aria-describedby="log-history-count"
    onClose={() => { if (!dialogRef.current?.open) onClose() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close()
    }}>
    <header className="log-history-header">
      <div><h2 id="log-history-heading">工作日志 <time dateTime={day}>{fullDate.format(dateFromKey(day))}</time></h2><p id="log-history-count">共 {recordsProps.records.length} 条工作记录</p></div>
      <div className="log-header-actions">
        <button className="report-button report-generate" disabled={recordsProps.disabled || (!recordsProps.records.length && !recordsProps.dailyReport)} title={recordsProps.dailyReport ? '查看已保存日报，可补充整理待整理的记录' : '归类总结这一天的工作日志'} onClick={() => setReportOpen(true)}><Icon name="list" />{recordsProps.dailyReport ? '查看日报' : '生成日报'}</button>
        <button className="log-history-close" autoFocus aria-label="关闭工作日志窗口" onClick={() => dialogRef.current?.close()}><Icon name="close" /></button>
      </div>
    </header>
    <LogRecords {...recordsProps} />
    {reportOpen && <DailyReportDialog key={day} day={day} records={recordsProps.records} savedReport={recordsProps.dailyReport ?? null} onSaved={onReportSaved} onClose={() => setReportOpen(false)} />}
  </dialog>, document.body)
}
