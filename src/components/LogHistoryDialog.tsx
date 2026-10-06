import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dateFromKey } from '../domain/workbench'
import { Icon } from './Icon'
import { LogRecords } from './LogRecords'
import type { LogRecordsProps } from './LogRecords'
import { DailyReportDialog } from './DailyReportDialog'
import { fetchRecords, fetchDailyReport, fetchDailyReportStatus } from '../data/apiRepository'
import type { Task } from '../domain/workbench'
import type { DailyReport } from '../../shared/contracts'

const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
interface LogHistoryDialogProps extends LogRecordsProps {
  dataVersion?: string
  day: string
  onReportSaved: (report: DailyReport) => void
  onClose: () => void
}

export function LogHistoryDialog({ day, dataVersion, onReportSaved, onClose, ...recordsProps }: LogHistoryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [records, setRecords] = useState<Task[]>(recordsProps.records)
  const [report, setReport] = useState<DailyReport | null>(recordsProps.dailyReport ?? null)
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0)
  const [workRecordCount, setWorkRecordCount] = useState(0)
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(null)
    void Promise.all([fetchRecords({ startDate: day, endDate: day, onlyRecords: true, offset, limit: 100 }, controller.signal), fetchDailyReport(day, controller.signal), fetchDailyReportStatus(day, controller.signal)])
      .then(([page, saved, status]) => { if (controller.signal.aborted) return; setRecords((current) => offset ? [...current, ...page.tasks] : page.tasks); setTotal(page.total); setReport(saved); setWorkRecordCount(status.recordCount) })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '日志读取失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [day, offset, refreshVersion])
  useEffect(() => { setOffset(0); setRefreshVersion((v) => v + 1) }, [dataVersion])
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
  const handleTogglePersonal = async (task: Task) => {
    setError(null)
    try {
      const saved = await recordsProps.onTogglePersonal(task)
      setRecords((current) => current.map((item) => item.id === saved.id ? saved : item))
      setWorkRecordCount((count) => Math.max(0, count + (saved.isPersonal ? -1 : 1)))
      try { const current = await fetchDailyReport(day); setReport(current); if (current) onReportSaved(current) }
      catch { setRefreshVersion((version) => version + 1) }
      return saved
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '事项分类保存失败，请重试')
      throw cause
    }
  }
  return createPortal(<dialog className="log-history-dialog" ref={dialogRef} aria-labelledby="log-history-heading" aria-describedby="log-history-count"
    onClose={() => { if (!dialogRef.current?.open) onClose() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close()
    }}>
    <header className="log-history-header">
      <div><h2 id="log-history-heading">工作日志 <time dateTime={day}>{fullDate.format(dateFromKey(day))}</time></h2><p id="log-history-count">共 {total} 条日志，{workRecordCount} 条参与工作汇报</p></div>
      <div className="log-header-actions">
        <button className="report-button report-generate" disabled={recordsProps.disabled || loading || (!workRecordCount && !report)} title={report ? '查看已保存日报，可补充整理待整理的记录' : '归类总结这一天的工作日志，忽略个人事项'} onClick={() => setReportOpen(true)}><Icon name="list" />{report ? '查看日报' : '生成日报'}</button>
        <button className="log-history-close" autoFocus aria-label="关闭工作日志窗口" onClick={() => dialogRef.current?.close()}><Icon name="close" /></button>
      </div>
    </header>
    {loading && <p role="status">正在读取工作日志…</p>}
    {error && <p role="alert">{error}<button type="button" onClick={() => setRefreshVersion((v) => v + 1)}>重试</button></p>}
    <LogRecords {...recordsProps} records={records} dailyReport={report} disabled={recordsProps.disabled || loading} onTogglePersonal={handleTogglePersonal} />
    {records.length < total && <button className="report-button" disabled={loading} onClick={() => setOffset(records.length)}>加载更多（{records.length}/{total}）</button>}
    {reportOpen && <DailyReportDialog key={day} day={day} records={records} savedReport={report} onSaved={(saved) => { setReport(saved); onReportSaved(saved) }} onClose={() => setReportOpen(false)} />}
  </dialog>, document.body)
}
