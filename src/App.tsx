import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dateKey, recentWorkdays, recordsForDate } from './domain/workbench'
import type { Task, WorkbenchState } from './domain/workbench'
import type { WorkbenchSnapshot } from '../shared/contracts'
import { createTask, fetchWorkbench, migrateLegacyTasks, startSync, updateTask } from './data/apiRepository'
import { TaskPanel } from './components/TaskPanel'
import { ProcessorHub } from './components/ProcessorHub'
import type { TransferPhase } from './components/ProcessorHub'
import { DailyLogBook } from './components/DailyLogBook'
import { createTransferJob, TransferLayer } from './components/TransferLayer'
import type { TransferJob } from './components/TransferLayer'
import { Icon } from './components/Icon'

const busPaths = ['M 100 240 L 460 240 L 520 280 L 700 280', 'M 100 420 L 480 420 L 540 320 L 700 320', 'M 700 280 L 880 280 L 940 240 L 1300 240', 'M 700 320 L 860 320 L 920 420 L 1300 420']
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' })
const phaseLabels = { inbound: '待办正在汇入核心', orbit: '核心正在处理 · 环轨加速', outbound: '正在收进今天的日报', idle: '工作流就绪，等待下一次推进' }

export default function App() {
  const [state, setState] = useState<WorkbenchState>({ version: 1, tasks: [] })
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => new Date())
  const today = dateKey(clock)
  const [selectedDay, setSelectedDay] = useState(today)
  const [job, setJob] = useState<TransferJob | null>(null)
  const [phase, setPhase] = useState<TransferPhase>('idle')
  const [recentId, setRecentId] = useState<string | null>(null)
  const [changingId, setChangingId] = useState<string | null>(null)
  const [syncRequested, setSyncRequested] = useState(false)
  const busy = useRef(false)
  const mutationVersion = useRef(0)
  const refreshing = useRef(false)
  const connectionError = useRef(false)
  const completedTask = useRef<Task | null>(null)
  const panelRef = useRef<HTMLElement>(null), deckRef = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null), rightPin = useRef<HTMLSpanElement>(null)
  const [leftPins] = useState(() => Array.from({ length: 4 }, () => createRef<HTMLSpanElement>()))
  const processorRefs = { chip, ring, rightPin, leftPins }
  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    const version = mutationVersion.current
    try {
      const result = await fetchWorkbench()
      setSnapshot(result); setConnected(true)
      if (connectionError.current) { setError(null); connectionError.current = false }
      // 归档动效期间不让后台刷新提前移除正在传输的卡片。
      if (!busy.current && version === mutationVersion.current) setState({ version: 1, tasks: result.tasks })
    } catch (cause) { connectionError.current = true; setConnected(false); setError(cause instanceof Error ? cause.message : '工作台加载失败') }
    finally { refreshing.current = false }
  }, [])
  useEffect(() => {
    let disposed = false
    void (async () => {
      try { const migrationNotice = await migrateLegacyTasks(); if (!disposed) setNotice(migrationNotice) }
      catch (cause) { if (!disposed) setNotice(cause instanceof Error ? `旧记录暂未迁移：${cause.message}` : '旧记录暂未迁移，刷新页面后重试') }
      if (!disposed) { await refresh(); setLoading(false) }
    })()
    const timer = window.setInterval(() => { if (!disposed) void refresh() }, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    const tick = () => setClock(new Date())
    const timer = window.setInterval(tick, 30000)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [])
  useEffect(() => { setSelectedDay(today) }, [today])
  useEffect(() => {
    if (!recentId) return
    const timer = window.setTimeout(() => setRecentId(null), 2500)
    return () => window.clearTimeout(timer)
  }, [recentId])
  const days = useMemo(() => [...new Set([...recentWorkdays(clock), ...state.tasks.filter((task) => task.completedAt).map((task) => dateKey(new Date(task.completedAt!)))])].sort().reverse(), [clock, state.tasks])
  const pending = state.tasks.filter((task) => !task.completedAt)
  const completedCount = recordsForDate(state, today).length
  const finishTransfer = useCallback((taskId: string) => {
    const saved = completedTask.current
    if (saved && saved.id === taskId) setState((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? saved : task) }))
    const now = new Date(); setClock(now); setSelectedDay(dateKey(now)); setRecentId(taskId)
    setPhase('idle'); setJob(null); setChangingId(null); completedTask.current = null; busy.current = false
    mutationVersion.current++
  }, [])
  async function handleComplete(task: Task, button: HTMLButtonElement) {
    if (busy.current) return
    busy.current = true; mutationVersion.current++; setChangingId(task.id); setError(null)
    try {
      completedTask.current = await updateTask(task.id, true)
      setSelectedDay(today)
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.innerWidth < 1100 || !panelRef.current || !deckRef.current || !button.isConnected) { finishTransfer(task.id); return }
      const nextJob = createTransferJob(task.id, task.reference, button, processorRefs, panelRef.current, deckRef.current)
      if (!nextJob) { finishTransfer(task.id); return }
      setPhase('inbound'); setJob(nextJob)
    } catch (cause) { busy.current = false; setChangingId(null); setError(cause instanceof Error ? cause.message : '完成操作失败') }
  }
  async function handleAdd(title: string) {
    mutationVersion.current++
    setError(null)
    try { const task = await createTask(title); setState((current) => ({ ...current, tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)] })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '添加失败'); throw cause }
    finally { mutationVersion.current++ }
  }
  async function handleReopen(task: Task) {
    if (busy.current) return
    busy.current = true; mutationVersion.current++; setChangingId(task.id); setError(null)
    try { const saved = await updateTask(task.id, false); setState((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === task.id ? saved : item) })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '恢复操作失败') }
    finally { mutationVersion.current++; busy.current = false; setChangingId(null) }
  }
  async function handleSync() {
    setSyncRequested(true); setError(null)
    try { await startSync(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '同步启动失败') }
    finally { setSyncRequested(false) }
  }
  const status = job ? phaseLabels[phase] : recentId ? '✓ 已收进今天的日报' : loading ? '正在连接工作台服务' : phaseLabels.idle
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-section"><div className="brand-badge" aria-hidden="true">QA</div><div className="brand-title"><h1>我的工作台</h1><p>汇聚待办，沉淀每一天的进展</p></div><span className="live-indicator"><span className="live-dot" />{connected ? '本机工作台' : '服务未连接'}</span></div>
        <div className="top-meta"><time className="header-date" dateTime={today}>{dateFormatter.format(clock)}</time><div className="user-pill"><span>个人工作空间</span><span className="user-avatar" aria-hidden="true">我</span></div></div>
      </header>
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      {error && <p className="storage-notice request-error" role="alert">{error}<button onClick={() => { setError(null); void refresh() }}>重新连接</button></p>}
      <main className="stage-container">
        <svg className="idle-bus-layer" viewBox="0 0 1400 680" preserveAspectRatio="none" aria-hidden="true">{busPaths.map((path, index) => <g key={path}><path className="idle-track" d={path} /><path className="idle-flow-beam" d={path} style={{ animationDelay: `${index * .75}s` }} /></g>)}</svg>
        <TaskPanel tasks={pending} panelRef={panelRef} activeId={changingId} disabled={loading || !connected || changingId !== null} onAdd={handleAdd} onComplete={(task, button) => { void handleComplete(task, button) }} />
        <ProcessorHub refs={processorRefs} phase={phase} activePin={job?.activePin ?? 0} pendingCount={pending.length} completedCount={completedCount} status={status} harness={snapshot?.harness} sources={snapshot?.sources} onSync={() => { void handleSync() }} syncDisabled={loading || !connected || syncRequested} />
        <DailyLogBook state={state} days={days} today={today} selectedDay={selectedDay} onSelectDay={setSelectedDay} deckRef={deckRef} recentId={recentId} onReopen={(task) => { void handleReopen(task) }} disabled={!connected || changingId !== null} />
      </main>
      <footer className="app-footer"><span className={connected ? 'save-state' : 'save-state save-unavailable'} role="status"><Icon name="check" />{connected ? '记录保存在本机数据库' : '服务暂不可用，页面保留已加载记录'}</span><span>Codex · Claude Code · 每 10 分钟同步</span></footer>
      {job && <TransferLayer job={job} onPhase={setPhase} onDone={finishTransfer} />}
    </div>
  )
}
