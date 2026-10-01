import type { RefObject } from 'react'
import { SOURCES } from '../domain/workbench'
import type { SourceId } from '../domain/workbench'
import type { WorkbenchSnapshot } from '../../shared/contracts'

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
  activePin: number
  pendingCount: number
  completedCount: number
  status: string
  harness?: WorkbenchSnapshot['harness']
  sources?: WorkbenchSnapshot['sources']
  onSync: () => void
  syncDisabled: boolean
}

const engineSources: SourceId[] = ['zentao', 'claude', 'codex', 'workbuddy']

export function ProcessorHub({ refs, phase, activePin, pendingCount, completedCount, status, harness, sources, onSync, syncDisabled }: ProcessorHubProps) {
  const running = harness?.run?.status === 'running'
  const energized = running || phase === 'orbit' || phase === 'outbound'
  const labels = { scanning: '扫描记录', extracting: '抽取工作事项', saving: '保存事项', idle: '同步结束' }
  const run = harness?.run
  const syncTime = run?.finishedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(run.finishedAt)) : null
  return (
    <section className="center-processor-hub" aria-label="工作流处理核心">
      <div className="hub-top-hud">
        <div className="hud-stat-col">
          <span className="stat-num accent">{String(completedCount).padStart(2, '0')}<small>项</small></span>
          <span className="stat-lbl">今日已完成</span>
        </div>
        <div className="hud-mini-wave" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span className="wave-bar" key={index} />)}</div>
        <div className="hud-stat-col hud-stat-right">
          <span className="stat-num">{String(pendingCount).padStart(2, '0')}<small>项</small></span>
          <span className="stat-lbl">等待推进</span>
        </div>
      </div>

      <div className="chip-carrier-board">
        <div className="motherboard-traces" aria-hidden="true">
          <span className="pcb-test-point tp-top-left">待办汇入</span>
          <span className="pcb-test-point tp-bottom-right">日报归档</span>
        </div>
        <div className={`processor-chip${energized ? ' energized' : ''}`} ref={refs.chip}>
          <div className="chip-pins-top" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span className="chip-pin" key={index} />)}</div>
          <div className="chip-pins-bottom" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span className="chip-pin" key={index} />)}</div>
          <div className="chip-pins-left" aria-hidden="true">
            {refs.leftPins.map((ref, index) => <span ref={ref} className={`chip-pin-h${phase === 'orbit' && index === activePin ? ' pin-active' : ''}`} key={index} />)}
          </div>
          <div className="chip-pins-right" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => <span ref={index === 1 ? refs.rightPin : undefined} className={`chip-pin-h${phase === 'outbound' && index === 1 ? ' pin-active' : ''}`} key={index} />)}
          </div>
          <div className="holo-scale-ring" aria-hidden="true" />
          <div className="chip-accelerator-ring" ref={refs.ring} aria-hidden="true" />
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
          {engineSources.map((source) => (
            <div className="engine-node-pill" key={source}>
              <div className="node-meta">
                <span className="node-name">{SOURCES[source].label}</span>
                <span className="node-status">{source === 'codex' || source === 'claude' ? sources?.[source]?.available ? `${sources[source].sessionCount} 个会话 · 已接入` : sources?.[source]?.error ?? '等待扫描' : '待接入'}</span>
              </div>
              <span className="node-pulse" aria-hidden="true" />
            </div>
          ))}
        </div>
        <div className="center-stats-badge">
          <span className={`count-box${phase !== 'idle' ? ' is-active' : ''}`} role="status" aria-live="polite">{status}</span>
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
