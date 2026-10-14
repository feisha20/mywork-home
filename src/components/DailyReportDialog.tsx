import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DailyReport } from '../../shared/contracts'
import type { Task } from '../domain/workbench'
import { dailyReportText, dailyReportTitle } from '../domain/dailyReport'
import { generateDailyReport, loadOrCreateDailyReport, fetchDailyReportStatus } from '../data/apiRepository'
import { dailyReportItemDisplay, isRecordInReport } from '../../shared/dailyReports'
import { copyReportText } from '../data/clipboard'
import { ModelStatus } from './ModelStatus'
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
  const [action, setAction] = useState<'initial' | 'append' | 'regenerate'>('initial')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle')
  const [copyError, setCopyError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [coverage, setCoverage] = useState<{ recordCount: number; unorganizedCount: number } | null>(null)
  const workRecordCount = records.filter((task) => !task.isPersonal).length
  const unorganizedCount = coverage?.unorganizedCount ?? records.filter((task) => !task.isPersonal && !isRecordInReport(task, report)).length

  useEffect(() => {
    if (savedReport) setReport((current) => !current || savedReport.revision > current.revision ? savedReport : current)
  }, [savedReport])

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

  useEffect(() => {
    const controller = new AbortController()
    void fetchDailyReportStatus(day, controller.signal).then((value) => { if (!controller.signal.aborted) setCoverage(value) }).catch(() => {})
    return () => controller.abort()
  }, [day, report?.revision, records])

  const handleOrganize = async (mode: 'initial' | 'append' | 'regenerate') => {
    if (pending || (mode === 'append' && !unorganizedCount)) return
    const controller = new AbortController()
    requestRef.current = controller
    setAction(mode); setFeedback(null); setPending(true); setError(null); setCopyState('idle'); setCopyError(null)
    try {
      const result = await generateDailyReport(day, controller.signal, mode)
      if (!controller.signal.aborted) {
        setReport(result); onSaved(result)
        setFeedback(mode === 'regenerate' ? '已重新整理并保存日报。' : mode === 'append' ? '已补充整理并保存日报。' : '已生成并保存日报。')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '整理失败，已保存的日报保留')
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
      <div><h2 id={headingId}>{dailyReportTitle(day)}</h2><p id={helpId}>按项目与工作目标归类，忽略个人事项，保留各项工作成果与实际进展，合并重复内容。</p></div>
      <button className="log-history-close" autoFocus aria-label="关闭工作日报窗口" onClick={() => dialogRef.current?.close()}><Icon name="close" /></button>
    </header>
    <div className="daily-report-body" aria-busy={pending}>
      {pending && <div className="daily-report-progress" role="status"><span className="report-spinner" aria-hidden="true" /><div><p>{action === 'regenerate' ? '正在重新整理全部工作日志…' : action === 'append' ? '正在补充整理工作日报…' : '正在读取或整理工作日报…'}</p><span>{action === 'regenerate' ? '重新归类并撰写，成功后替换已保存日报。' : '已有日报直接读取，补充时仅整理未纳入的工作记录。'}</span></div></div>}
      {feedback && <p className="daily-report-change" role="status">{feedback}</p>}
      {error && <p className="daily-report-error" role="alert">{error}</p>}
      {report && <section className="daily-report-preview" aria-label="工作日报正文">
        <p className="daily-report-meta">已保存{report.edited ? ' · 助手编辑，自动整理保留正文' : ''} · 已整理 {report.recordCount} 条记录，汇总为 {report.items.length} 项工作</p>
        <h3>{dailyReportTitle(report.day)}</h3>
        <ol>{report.items.map((item, index) => {
          const display = dailyReportItemDisplay(item)
          return <li key={index}>{display ? <><strong className="daily-report-topic">{display.heading}</strong><ul className="daily-report-subitems">{display.subItems.map((text, subIndex) => <li key={subIndex}>{text}</li>)}</ul></> : item.text}</li>
        })}</ol>
        {!report.items.length && <p>已排除个人事项，当前暂无已整理的工作摘要。</p>}
      </section>}
      {report && unorganizedCount > 0 && !pending && <p className="daily-report-change" role="status">还有 {unorganizedCount} 条新增或更新的日志待整理，可点击“补充整理”纳入日报。</p>}
    </div>
    <footer className="daily-report-footer">
      <div className="daily-report-footer-info">
        <div className="daily-report-copy-status" aria-live="polite">
          {copyError ? <p role="alert">{copyError}</p> : copyState === 'copied' ? <p>已复制，可直接粘贴。</p> : <p>{report ? '重新整理会替换日报；补充整理仅纳入新增或更新日志。' : '复制内容包含日期和分点总结。'}</p>}
        </div>
        <ModelStatus live compact />
      </div>
      <div className="daily-report-actions">
        {report && unorganizedCount > 0 && <button className="report-button report-regenerate" disabled={pending || !(coverage?.recordCount ?? workRecordCount)} onClick={() => void handleOrganize('append')}>补充整理（{unorganizedCount}）</button>}
        <button className="report-button report-regenerate" disabled={pending || !(coverage?.recordCount ?? workRecordCount)} onClick={() => void handleOrganize(report ? 'regenerate' : 'initial')}>{report ? '重新整理' : '重试生成'}</button>
        <button className="report-button report-copy" disabled={!report?.items.length || pending || copyState === 'copying'} onClick={() => void handleCopy()}><Icon name={copyState === 'copied' ? 'check' : 'copy'} />{copyState === 'copied' ? '已复制' : copyState === 'copying' ? '正在复制…' : '一键复制'}</button>
      </div>
    </footer>
  </dialog>, document.body)
}
