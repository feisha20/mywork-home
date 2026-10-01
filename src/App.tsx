import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addTask, completeTask, dateKey, recentWorkdays, recordsForDate } from './domain/workbench'
import type { Task } from './domain/workbench'
import { loadWorkbench, saveWorkbench } from './data/localRepository'
import { TaskPanel } from './components/TaskPanel'
import { ProcessorHub } from './components/ProcessorHub'
import type { TransferPhase } from './components/ProcessorHub'
import { DailyLogBook } from './components/DailyLogBook'
import { createTransferJob, TransferLayer } from './components/TransferLayer'
import type { TransferJob } from './components/TransferLayer'
import { Icon } from './components/Icon'

const busPaths = [
  'M 100 240 L 460 240 L 520 280 L 700 280',
  'M 100 420 L 480 420 L 540 320 L 700 320',
  'M 700 280 L 880 280 L 940 240 L 1300 240',
  'M 700 320 L 860 320 L 920 420 L 1300 420',
]
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const phaseLabels = { inbound: '待办正在汇入核心', orbit: '核心正在处理 · 环轨加速', outbound: '正在收进今天的日报', idle: '工作流就绪，等待下一次推进' }

export default function App() {
  const [initial] = useState(() => loadWorkbench(new Date()))
  const [state, setState] = useState(initial.state)
  const [clock, setClock] = useState(() => new Date())
  const today = dateKey(clock)
  const [selectedDay, setSelectedDay] = useState(today)
  const [saved, setSaved] = useState(true)
  const [job, setJob] = useState<TransferJob | null>(null)
  const [phase, setPhase] = useState<TransferPhase>('idle')
  const [recentId, setRecentId] = useState<string | null>(null)
  const busy = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const rightPin = useRef<HTMLSpanElement>(null)
  const [leftPins] = useState(() => Array.from({ length: 4 }, () => createRef<HTMLSpanElement>()))
  const processorRefs = { chip, ring, rightPin, leftPins }

  useEffect(() => { setSaved(saveWorkbench(state)) }, [state])
  useEffect(() => {
    const tick = () => setClock(new Date())
    const timer = window.setInterval(tick, 30_000)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [])
  useEffect(() => { setSelectedDay(today) }, [today])
  useEffect(() => {
    if (!recentId) return
    const timer = window.setTimeout(() => setRecentId(null), 2500)
    return () => window.clearTimeout(timer)
  }, [recentId])

  const days = useMemo(() => [...new Set([
    ...recentWorkdays(clock),
    ...state.tasks.filter((task) => task.completedAt).map((task) => dateKey(new Date(task.completedAt!))),
  ])].sort().reverse(), [clock, state.tasks])
  const pending = state.tasks.filter((task) => !task.completedAt)
  const completedCount = recordsForDate(state, today).length

  const finishTransfer = useCallback((taskId: string) => {
    const now = new Date()
    setClock(now)
    setState((current) => completeTask(current, taskId, now))
    setSelectedDay(dateKey(now))
    setRecentId(taskId)
    setPhase('idle')
    setJob(null)
    busy.current = false
  }, [])

  function handleComplete(task: Task, button: HTMLButtonElement) {
    if (busy.current) return
    busy.current = true
    setSelectedDay(today)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // 紧凑布局直接归档，卡片动效仍由 Motion 保持连贯。
    if (reducedMotion || window.innerWidth < 1100 || !panelRef.current || !deckRef.current) {
      finishTransfer(task.id)
      return
    }
    const nextJob = createTransferJob(task.id, task.reference, button, processorRefs, panelRef.current, deckRef.current)
    if (!nextJob) { finishTransfer(task.id); return }
    setPhase('inbound')
    setJob(nextJob)
  }

  const status = job ? phaseLabels[phase] : recentId ? '✓ 已收进今天的日报' : phaseLabels.idle
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-section">
          <div className="brand-badge" aria-hidden="true">QA</div>
          <div className="brand-title"><h1>我的工作台</h1><p>汇聚待办，沉淀每一天的进展</p></div>
          <span className="live-indicator"><span className="live-dot" />本机演示</span>
        </div>
        <div className="top-meta">
          <time className="header-date" dateTime={today}>{dateFormatter.format(clock)}</time>
          <div className="user-pill"><span>个人工作空间</span><span className="user-avatar" aria-hidden="true">我</span></div>
        </div>
      </header>

      {initial.notice && <p className="storage-notice" role="status">{initial.notice}</p>}
      <main className="stage-container">
        <svg className="idle-bus-layer" viewBox="0 0 1400 680" preserveAspectRatio="none" aria-hidden="true">
          {busPaths.map((path, index) => <g key={path}><path className="idle-track" d={path} /><path className="idle-flow-beam" d={path} style={{ animationDelay: `${index * 0.75}s` }} /></g>)}
        </svg>
        <TaskPanel tasks={pending} panelRef={panelRef} activeId={job?.taskId ?? null} onAdd={(title) => setState((current) => addTask(current, title, crypto.randomUUID(), new Date()))} onComplete={handleComplete} />
        <ProcessorHub refs={processorRefs} phase={phase} activePin={job?.activePin ?? 0} pendingCount={pending.length} completedCount={completedCount} status={status} />
        <DailyLogBook state={state} days={days} today={today} selectedDay={selectedDay} onSelectDay={setSelectedDay} deckRef={deckRef} recentId={recentId} />
      </main>
      <footer className="app-footer">
        <span className={saved ? 'save-state' : 'save-state save-unavailable'} role="status"><Icon name="check" />{saved ? '已保存在本机' : '本机存储不可用，请保持页面打开'}</span>
        <span>示例数据 · 外部工具尚未连接</span>
      </footer>
      {job && <TransferLayer job={job} onPhase={setPhase} onDone={finishTransfer} />}
    </div>
  )
}
