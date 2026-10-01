import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DailyReport } from '../../shared/contracts'
import type { Task } from '../domain/workbench'
import { dailyReportText, dailyReportTitle } from '../domain/dailyReport'
import { generateDailyReport, loadOrCreateDailyReport } from '../data/apiRepository'
import { isRecordInReport } from '../../shared/dailyReports'
import { copyReportText } from '../data/clipboard'
import { Icon } from './Icon'

interface DailyReportDialogProps {
  day: string
  records: Task[]
  savedReport: DailyReport | null
  onSaved: (report: DailyReport) => void
  onClose: () => void
}

export function DailyReportDialog({ day, records, savedReport, onSaved, onClose }: DailyReportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const headingId = useId(), helpId = useId()
  const [pending, setPending] = useState(true)
  const [report, setReport] = useState<DailyReport | null>(savedReport)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle')
  const [copyError, setCopyError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const unorganizedCount = records.filter((task) => !isRecordInReport(task, report)).length

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

  useEffect(() => {
    const controller = new AbortController()
    requestRef.current = controller
    setPending(true); setError(null); setCopyState('idle'); setCopyError(null)
    void loadOrCreateDailyReport(day, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setReport(result); onSaved(result)
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '工作日报生成失败，请稍后重试')
    }).finally(() => { if (!controller.signal.aborted) setPending(false) })
    return () => { controller.abort(); requestRef.current?.abort() }
    // 普通打开只读取已保存日报；日志变化不会自动触发补充生成。
  }, [day])

  const handleSupplement = async () => {
    if (pending || (report && !unorganizedCount)) return
    const controller = new AbortController()
    requestRef.current = controller
    setPending(true); setError(null); setCopyState('idle'); setCopyError(null)
    try {
      const result = await generateDailyReport(day, controller.signal, report ? 'append' : 'initial')
      if (!controller.signal.aborted) { setReport(result); onSaved(result) }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '补充整理失败，已保存的日报保留')
    } finally { if (!controller.signal.aborted) setPending(false) }
  }

  const handleCopy = async () => {
    if (!report || copyState === 'copying') return
    setCopyState('copying'); setCopyError(null)
    try { await copyReportText(dailyReportText(report)); setCopyState('copied') }
    catch (cause) { setCopyState('idle'); setCopyError(cause instanceof Error ? cause.message : '复制失败，请选中日报内容手动复制') }
  }

  return createPortal(<dialog className="daily-report-dialog" ref={dialogRef} aria-labelledby={headingId} aria-describedby={helpId}
    onClose={() => { if (!dialogRef.current?.open) onClose() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close()
    }}>
    <header className="daily-report-header">
      <div><h2 id={headingId}>{dailyReportTitle(day)}</h2><p id={helpId}>按项目与工作目标归类，每项用一句话概括主要进展。</p></div>
      <button className="log-history-close" autoFocus aria-label="关闭工作日报窗口" onClick={() => dialogRef.current?.close()}><Icon name="close" /></button>
    </header>
    <div className="daily-report-body" aria-busy={pending}>
      {pending && <div className="daily-report-progress" role="status"><span className="report-spinner" aria-hidden="true" /><div><p>正在读取或整理工作日报…</p><span>已有日报直接读取，补充时仅整理未纳入的工作记录。</span></div></div>}
      {error && <p className="daily-report-error" role="alert">{error}</p>}
      {report && <section className="daily-report-preview" aria-label="工作日报正文">
        <p className="daily-report-meta">已保存 · 已整理 {report.recordCount} 条记录，汇总为 {report.items.length} 项工作</p>
        <h3>{dailyReportTitle(report.day)}</h3>
        <ol>{report.items.map((item, index) => <li key={index}>{item.text}</li>)}</ol>
      </section>}
      {report && unorganizedCount > 0 && !pending && <p className="daily-report-change" role="status">还有 {unorganizedCount} 条新增或更新的日志待整理，可点击“补充整理”纳入日报。</p>}
    </div>
    <footer className="daily-report-footer">
      <div className="daily-report-copy-status" aria-live="polite">
        {copyError ? <p role="alert">{copyError}</p> : copyState === 'copied' ? <p>已复制，可直接粘贴。</p> : <p>复制内容包含日期和分点总结。</p>}
      </div>
      <div className="daily-report-actions">
        <button className="report-button report-regenerate" disabled={pending || !records.length || Boolean(report && !unorganizedCount)} onClick={() => void handleSupplement()}>{report ? unorganizedCount ? `补充整理（${unorganizedCount}）` : '已全部整理' : '重试生成'}</button>
        <button className="report-button report-copy" disabled={!report || pending || copyState === 'copying'} onClick={() => void handleCopy()}><Icon name={copyState === 'copied' ? 'check' : 'copy'} />{copyState === 'copied' ? '已复制' : copyState === 'copying' ? '正在复制…' : '一键复制'}</button>
      </div>
    </footer>
  </dialog>, document.body)
}
