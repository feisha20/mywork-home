import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { WorkbenchSnapshot } from '../../shared/contracts'
import { CAPTURE_SOURCES, sourceInfo } from '../domain/workbench'
import { channelStatus, type CaptureSource } from '../domain/channelDock'
import { Icon } from './Icon'
import { ChannelLogo } from './ChannelLogo'

interface ChannelDetailsDialogProps {
  sources?: WorkbenchSnapshot['sources']
  channels?: WorkbenchSnapshot['channels']
  harness?: WorkbenchSnapshot['harness']
  activeSource: CaptureSource | null
  selected: CaptureSource | 'sync' | 'all'
  onClose: () => void
}
const fullTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' })
const syncLabels = { running: '同步进行中', succeeded: '同步完成', partial_failed: '部分记录待重试', failed: '同步失败', interrupted: '同步已中断' }

export function ChannelDetailsDialog({ sources, channels, harness, activeSource, selected, onClose }: ChannelDetailsDialogProps) {
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
  const run = harness?.run
  const warnings = new Map<string, number>()
  for (const error of run?.errors ?? []) warnings.set(error, (warnings.get(error) ?? 0) + 1)
  return createPortal(<dialog className="channel-details-dialog" ref={dialogRef} aria-labelledby="channel-details-heading"
    onClose={() => { if (!dialogRef.current?.open) onClose() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close()
    }}>
    <header className="channel-details-header">
      <div><h2 id="channel-details-heading">采集详情</h2><p>渠道状态与最近一次同步</p></div>
      <button className="log-history-close" autoFocus aria-label="关闭采集详情" onClick={() => dialogRef.current?.close()}><Icon name="close" /></button>
    </header>
    <div className="channel-details-body">
      <ul className="channel-detail-list" aria-label="全部采集渠道">
        {(channels?.map((channel) => channel.id) ?? CAPTURE_SOURCES).map((source) => {
          const state = channelStatus(source, sources, activeSource, run?.errors)
          const info = sourceInfo(source, channels)
          return <li key={source} className={`channel-detail-row${selected === source ? ' is-selected' : ''}`}>
            <ChannelLogo logo={info.logo} name={info.label} />
            <div className="channel-detail-copy"><strong>{info.label}</strong><span>{state.detail}</span></div>
            <span className={`channel-detail-state is-${state.kind}`}><i aria-hidden="true" />{state.label}</span>
          </li>
        })}
      </ul>
      <section className="sync-detail-section" aria-labelledby="sync-detail-heading">
        <h3 id="sync-detail-heading">最近同步</h3>
        {run ? <>
          <div className="sync-detail-result"><strong>{syncLabels[run.status]}</strong><time dateTime={run.finishedAt ?? run.startedAt}>{fullTime.format(new Date(run.finishedAt ?? run.startedAt))}</time></div>
          <dl className="sync-detail-numbers"><div><dt>读取消息</dt><dd>{run.newMessages}</dd></div><div><dt>新增记录</dt><dd>{run.newTasks}</dd></div><div><dt>更新记录</dt><dd>{run.updatedTasks}</dd></div></dl>
          {!!((run.ignoredFiles ?? 0) + (run.skippedRecords ?? 0)) && <p className="sync-detail-empty">{[
            run.ignoredFiles ? `已忽略 ${run.ignoredFiles} 份连续两次读取失败的日志，内容变化后重新采集` : '',
            run.skippedRecords ? `已跳过 ${run.skippedRecords} 条损坏或超大记录` : '',
          ].filter(Boolean).join('；')}。</p>}
          {warnings.size > 0 && <details className="sync-detail-warnings" open={selected === 'sync'}><summary>{run.errors.length} 条同步提示</summary><ul>{[...warnings].map(([error, count]) => <li key={error}><span>{error}</span>{count > 1 && <small>×{count}</small>}</li>)}</ul></details>}
        </> : <p className="sync-detail-empty">等待首次同步，采集完成后显示结果。</p>}
      </section>
    </div>
    <p className="channel-details-note">禅道待处理事项进入待办；会话采集的工作记录按原始日期进入日志。</p>
  </dialog>, document.body)
}
