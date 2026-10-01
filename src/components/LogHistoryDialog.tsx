import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { dateFromKey } from '../domain/workbench'
import { Icon } from './Icon'
import { LogRecords } from './LogRecords'
import type { LogRecordsProps } from './LogRecords'

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
interface LogHistoryDialogProps extends LogRecordsProps {
  day: string
  onClose: () => void
}

export function LogHistoryDialog({ day, onClose, ...recordsProps }: LogHistoryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
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
      <button className="log-history-close" autoFocus aria-label="关闭工作日志窗口" onClick={() => dialogRef.current?.close()}><Icon name="close" /></button>
    </header>
    <LogRecords {...recordsProps} />
  </dialog>, document.body)
}
