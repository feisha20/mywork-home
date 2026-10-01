import { createRef, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { CAPTURE_SOURCES, SOURCES } from '../domain/workbench'
import type { WorkbenchSnapshot } from '../../shared/contracts'
import { SourceTransfer } from './SourceTransfer'
import type { CaptureRefs } from './SourceTransfer'

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
  onSync: () => void
  syncDisabled: boolean
  visible: boolean
}

// 上排接内侧引脚，后续各排接外侧引脚，避免采集线路交叉。
const bottomPinSources = ['zcode', 'codex', 'zentao', null, 'claude', 'workbuddy'] as const
function createCaptureRefs<T extends HTMLElement>(): CaptureRefs<T> {
  return Object.fromEntries(CAPTURE_SOURCES.map((source) => [source, createRef<T>()])) as CaptureRefs<T>
}

export function ProcessorHub({ refs, phase, routing, activePin, pendingCount, completedCount, status, harness, sources, onSync, syncDisabled, visible }: ProcessorHubProps) {
  const hubRef = useRef<HTMLElement>(null)
  const [sourceRefs] = useState(() => createCaptureRefs<HTMLDivElement>())
  const [sourcePorts] = useState(() => createCaptureRefs<HTMLSpanElement>())
  const [bottomPins] = useState(() => createCaptureRefs<HTMLSpanElement>())
  const running = harness?.run?.status === 'running'
  const energized = running || phase !== 'idle' || routing
  const labels = { scanning: '扫描记录', extracting: '抽取工作事项', saving: '保存事项', idle: '同步结束' }
  const run = harness?.run
  const activeSource = running && (run?.phase === 'scanning' || run?.phase === 'extracting') ? run.activeSource ?? null : null
  const syncTime = run?.finishedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(run.finishedAt)) : null
  return (
    <section className="center-processor-hub" ref={hubRef} aria-label="工作流处理核心">
      <SourceTransfer frameRef={hubRef} sourceRefs={sourceRefs} sourcePorts={sourcePorts} bottomPins={bottomPins} targetRef={refs.chip} activeSource={activeSource} working={energized} visible={visible} />
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
          <div className="chip-pins-bottom" aria-hidden="true">{bottomPinSources.map((source, index) => <span ref={source ? bottomPins[source] : undefined} className={`chip-pin${source && source === activeSource ? ' pin-active' : ''}`} key={index} />)}</div>
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
        <div className="engine-status-strip">
          {CAPTURE_SOURCES.map((source, index) => {
            const state = source === 'zentao' ? undefined : sources?.[source]
            return (
              <div className={`engine-node-pill${index % 2 === 0 ? ' source-on-left' : ''}${source === activeSource ? ' is-extracting' : ''}`} ref={sourceRefs[source]} key={source}>
                <div className="node-meta">
                  <span className="node-name">{SOURCES[source].label}</span>
                  <span className="node-status">{state ? state.available ? `${state.sessionCount} 个会话 · 已接入` : state.error ?? '等待扫描' : source === 'zentao' ? '待接入' : '等待扫描'}</span>
                </div>
                <span className="node-pulse" ref={sourcePorts[source]} aria-hidden="true" />
              </div>
            )
          })}
        </div>
        <div className="center-stats-badge">
          <span className={`count-box${energized ? ' is-active' : ''}`} role="status" aria-live="polite">{running && phase === 'idle' ? `${activeSource ? `${SOURCES[activeSource].label} · ` : ''}${labels[run!.phase]}` : status}</span>
        </div>
        <div className="sync-controls" aria-live="polite">
          <button className="sync-button" onClick={onSync} disabled={syncDisabled || running}>{running ? labels[run!.phase] : '同步本机记录'}</button>
          <span>{run ? running ? `已读取 ${run.newMessages} 条消息` : `${run.status === 'succeeded' ? '同步成功' : run.status === 'interrupted' ? '同步已中断' : '部分记录待重试'} · 新增 ${run.newTasks} 项 · 更新 ${run.updatedTasks} 项` : '启动后自动同步，每 10 分钟增量更新'}</span>
          {syncTime && <small>最近同步：{syncTime}</small>}
          {run?.errors.length ? <details><summary>{run.errors.length} 条同步提示</summary>{run.errors.map((message, index) => <p key={index}>{message}</p>)}</details> : null}
        </div>
      </div>
    </section>
  )
}
