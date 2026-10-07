import { createRef, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { CAPTURE_SOURCES, sourceInfo } from '../domain/workbench'
import type { WorkbenchSnapshot } from '../../shared/contracts'
import { SourceTransfer } from './SourceTransfer'
import { channelSlots, channelStatus, type CaptureSource } from '../domain/channelDock'
import { ChannelDetailsDialog } from './ChannelDetailsDialog'
import { Icon } from './Icon'
import { ChannelLogo } from './ChannelLogo'

export type TransferPhase = 'idle' | 'inbound' | 'orbit' | 'outbound'

export interface ProcessorRefs {
  chip: RefObject<HTMLDivElement | null>
  ring: RefObject<HTMLDivElement | null>
  leftPins: RefObject<HTMLSpanElement | null>[]
  rightPin: RefObject<HTMLSpanElement | null>
}

interface ProcessorHubProps {
  refs: ProcessorRefs
  phase: TransferPhase
  routing: boolean
  activePin: number
  pendingCount: number
  completedCount: number
  status: string
  harness?: WorkbenchSnapshot['harness']
  sources?: WorkbenchSnapshot['sources']
  channels?: WorkbenchSnapshot['channels']
  onSync: () => void
  syncDisabled: boolean
  visible: boolean
}

const shortTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

export function ProcessorHub({ refs, phase, routing, activePin, pendingCount, completedCount, status, harness, sources, channels, onSync, syncDisabled, visible }: ProcessorHubProps) {
  const channelIds = useMemo(() => channels?.map((channel) => channel.id) ?? [...CAPTURE_SOURCES], [channels])
  const slots = useMemo(() => channelSlots(channelIds), [channelIds])
  const hubRef = useRef<HTMLElement>(null)
  const [sourceRefs] = useState(() => Array.from({ length: 5 }, () => createRef<HTMLDivElement>()))
  const [sourcePorts] = useState(() => Array.from({ length: 5 }, () => createRef<HTMLSpanElement>()))
  const [bottomPins] = useState(() => Array.from({ length: 5 }, () => createRef<HTMLSpanElement>()))
  const [details, setDetails] = useState<CaptureSource | 'sync' | 'all' | null>(null)
  const running = harness?.run?.status === 'running'
  const energized = running || phase !== 'idle' || routing
  const labels = { scanning: '扫描记录', extracting: '抽取工作事项', saving: '保存事项', idle: '同步结束' }
  const run = harness?.run
  const activeSource = running && (run?.phase === 'scanning' || run?.phase === 'extracting') ? run.activeSource ?? null : null
  const syncTime = run?.finishedAt ? shortTime.format(new Date(run.finishedAt)) : null
  const connectedCount = channelIds.filter((source) => sources?.[source]?.enabled !== false && sources?.[source]?.available).length
  const hasWarnings = !!run && ['partial_failed', 'failed', 'interrupted'].includes(run.status)
  const syncLabel = phase !== 'idle' ? status : running ? `${activeSource ? `${sourceInfo(activeSource, channels).shortLabel} · ` : ''}${labels[run!.phase]}`
    : !run ? '等待首次同步' : `${syncTime ? `${syncTime} · ` : ''}${hasWarnings ? run.status === 'interrupted' ? '同步中断' : run.status === 'failed' ? '同步失败' : '部分待重试' : '已同步'}`
  return (
    <section className="center-processor-hub" ref={hubRef} aria-label="工作流处理核心">
      <SourceTransfer
        slots={slots}
        frameRef={hubRef}
        sourceRefs={sourceRefs}
        sourcePorts={sourcePorts}
        bottomPins={bottomPins}
        targetRef={refs.chip}
        activeSource={activeSource}
        sources={sources}
        runErrors={run?.errors}
        working={energized}
        visible={visible}
      />
      <div className="hub-top-hud">
        <div className="hud-stat-col">
          <span className="stat-num">{String(pendingCount).padStart(2, '0')}<small>项</small></span>
          <span className="stat-lbl">待推进</span>
        </div>
        <div className="hud-mini-wave" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span className="wave-bar" key={index} />)}</div>
        <div className="hud-stat-col hud-stat-right">
          <span className="stat-num accent">{String(completedCount).padStart(2, '0')}<small>项</small></span>
          <span className="stat-lbl">今日日志</span>
        </div>
      </div>

      <div className="chip-carrier-board">
        <div className="motherboard-traces" aria-hidden="true">
          <span className="pcb-test-point tp-top-left">待办分发</span>
          <span className="pcb-test-point tp-bottom-right">日报归档</span>
        </div>
        <div className={`processor-chip${energized ? ' energized' : ''}`} ref={refs.chip}>
          <div className="chip-pins-top" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span className="chip-pin" key={index} />)}</div>
          <div className="chip-pins-bottom" aria-hidden="true">{slots.map((slot, index) => <span ref={bottomPins[index]} className={`chip-pin${activeSource && slot.sources.includes(activeSource) ? ' pin-active' : ''}`} key={slot.id} />)}</div>
          <div className="chip-pins-left" aria-hidden="true">
            {refs.leftPins.map((ref, index) => <span ref={ref} className={`chip-pin-h${phase === 'orbit' && index === activePin ? ' pin-active' : ''}`} key={index} />)}
          </div>
          <div className="chip-pins-right" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => <span ref={index === 1 ? refs.rightPin : undefined} className={`chip-pin-h${phase === 'outbound' && index === 1 ? ' pin-active' : ''}`} key={index} />)}
          </div>
          <div className="holo-scale-ring" aria-hidden="true" />
          <div className="chip-accelerator-ring" ref={refs.ring} aria-hidden="true">
            <svg className="chip-ring-svg" viewBox="0 0 144 144" fill="none">
              <rect className="chip-ring-track" x="1" y="1" width="142" height="142" rx="27" pathLength="600" />
              <rect className="chip-ring-flow" x="1" y="1" width="142" height="142" rx="27" pathLength="600" />
            </svg>
          </div>
          <div className="chip-core">
            <svg className="core-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="2" y="2" width="20" height="20" rx="5" />
              <path d="M12 2v20M2 12h20M7 7h10v10H7z" />
            </svg>
            <span className="chip-label">DEEPSEEK</span>
            <span className="chip-subtitle">{running ? labels[run!.phase] : '工作流核心'}</span>
          </div>
        </div>
      </div>

      <div className="engine-matrix-wrap">
        <div className="channel-dock" style={{ '--channel-slots': slots.length } as CSSProperties}>
          <div className="channel-input-ports" aria-hidden="true">
            {slots.map((slot, index) => {
              const states = slot.sources.map((entry) => channelStatus(entry, sources, activeSource, run?.errors))
              const isConnected = states.some((entry) => entry.kind === 'connected' || entry.kind === 'warning' || entry.kind === 'active')
              const isActive = !!activeSource && slot.sources.includes(activeSource)
              return (
                <span
                  key={slot.id}
                  ref={sourcePorts[index]}
                  className={`channel-port${isActive ? ' is-active' : isConnected ? ' is-connected' : ' is-pending'}`}
                />
              )
            })}
          </div>
          <header className="channel-dock-header"><span>采集渠道</span><button onClick={() => setDetails('all')} aria-haspopup="dialog">{connectedCount}/{channelIds.length} 已接入 <Icon name="arrow" /></button></header>
          <div className="channel-dock-slots">
            {slots.map((slot, index) => {
              const source = slot.sources[0]
              const info = sourceInfo(source, channels)
              const states = slot.sources.map((entry) => channelStatus(entry, sources, activeSource, run?.errors))
              const state = states.find((entry) => entry.kind === 'warning') ?? states.find((entry) => entry.kind === 'connected') ?? states[0]
              const active = !!activeSource && slot.sources.includes(activeSource)
              const label = slot.overflow ? `更多 +${slot.sources.length}` : info.shortLabel
              const description = slot.overflow ? `查看另外 ${slot.sources.length} 个采集渠道` : `${info.label}，${state.detail}；查看详情`
              return <div className="channel-slot" ref={sourceRefs[index]} key={slot.id}>
                <button className={`channel-button is-${active ? 'active' : state.kind}${slot.overflow ? ' is-more' : ''}`} title={description} aria-label={description} aria-haspopup="dialog" onClick={() => setDetails(slot.overflow ? 'all' : source)}>
                  <span className="channel-logo">{slot.overflow ? <span className="channel-more-count">+{slot.sources.length}</span> : <ChannelLogo logo={info.logo} name={info.label} size={38} />}<i className="channel-status-dot" aria-hidden="true" /></span>
                  <span className="channel-name">{label}</span>
                </button>
              </div>
            })}
          </div>
        </div>
        <div className={`sync-bar${hasWarnings ? ' has-warnings' : ''}${running ? ' is-running' : !run ? ' is-waiting' : ''}`}>
          <button className="sync-summary" onClick={() => setDetails('sync')} aria-haspopup="dialog" title={`${syncLabel}；查看最近同步结果与提示`}><span className="sync-summary-title" role="status" aria-live="polite"><i aria-hidden="true" /><span className="sync-summary-text">{syncLabel}</span></span><span className="sync-summary-meta">{running ? `已读取 ${run!.newMessages} 条消息` : run?.errors.length ? `${run.errors.length} 条提示 · 查看详情` : run ? `新增 ${run.newTasks} · 更新 ${run.updatedTasks}` : '启动后自动同步'}</span></button>
          <button className="sync-button" onClick={onSync} disabled={syncDisabled || running}><Icon name="refresh" />{running ? '同步中' : '立即同步'}</button>
        </div>
      </div>
      {details && <ChannelDetailsDialog sources={sources} channels={channels} harness={harness} activeSource={activeSource} selected={details} onClose={() => setDetails(null)} />}
    </section>
  )
}
