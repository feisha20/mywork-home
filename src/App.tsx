import { createRef, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dateKey, recordsForDate, requiresManualCompletion } from './domain/workbench'
import type { Task, WorkbenchState } from './domain/workbench'
import type { DailyReport, WorkbenchSnapshot } from '../shared/contracts'
import { mergeDailyReports } from '../shared/dailyReports'
import { createTask, deleteTask, fetchWorkbench, migrateLegacyTasks, startSync, updateTask } from './data/apiRepository'
import { createAdaptivePolling } from './data/adaptivePolling'
import { changedCaptureDestinations } from './domain/captureFlow'
import { CaptureOutput } from './components/CaptureOutput'
import type { CaptureOutputEvent } from './components/CaptureOutput'
import { TaskPanel } from './components/TaskPanel'
import { ProcessorHub } from './components/ProcessorHub'
import type { TransferPhase } from './components/ProcessorHub'
import { DailyLogBook } from './components/DailyLogBook'
import { createTransferJob, TransferLayer } from './components/TransferLayer'
import type { TransferJob } from './components/TransferLayer'
import { Icon } from './components/Icon'
import { SettingsDialog } from './components/SettingsDialog'
import { PerpetualCalendar } from './components/PerpetualCalendar'
import { UserMenu } from './components/UserMenu'
import type { WorkbenchSettings } from '../shared/settings'

const PersonalSpace = lazy(() => import('./components/PersonalSpace').then((module) => ({ default: module.PersonalSpace })))

const busPaths = ['M 100 240 L 460 240 L 520 280 L 700 280', 'M 100 420 L 480 420 L 540 320 L 700 320', 'M 700 280 L 880 280 L 940 240 L 1300 240', 'M 700 320 L 860 320 L 920 420 L 1300 420']
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
  const [job, setJob] = useState<TransferJob | null>(null)
  const [phase, setPhase] = useState<TransferPhase>('idle')
  const [recentId, setRecentId] = useState<string | null>(null)
  const [changingId, setChangingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [syncRequested, setSyncRequested] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [spaceOpen, setSpaceOpen] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => !document.hidden)
  const [captureOutputs, setCaptureOutputs] = useState<CaptureOutputEvent[]>([])
  const captureBaseline = useRef<Task[] | null>(null)
  const captureSequence = useRef(0)
  const pollerRef = useRef<ReturnType<typeof createAdaptivePolling> | null>(null)
  const busy = useRef(false)
  const mutationVersion = useRef(0)
  const refreshing = useRef(false)
  const connectionError = useRef(false)
  const completedTask = useRef<Task | null>(null)
  const panelRef = useRef<HTMLElement>(null), deckRef = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null), rightPin = useRef<HTMLSpanElement>(null)
  const [leftPins] = useState(() => Array.from({ length: 4 }, () => createRef<HTMLSpanElement>()))
  const processorRefs = useMemo(() => ({ chip, ring, rightPin, leftPins }), [leftPins])
  const refresh = useCallback(async () => {
    if (refreshing.current) return null
    refreshing.current = true
    const version = mutationVersion.current
    try {
      const result = await fetchWorkbench()
      setSnapshot((current) => {
        const next = { ...result, dailyReports: mergeDailyReports(current?.dailyReports ?? [], result.dailyReports ?? []) }
        return JSON.stringify(current) === JSON.stringify(next) ? current : next
      }); setConnected(true)
      if (connectionError.current) { setError(null); connectionError.current = false }
      // 归档动效期间不让后台刷新提前移除正在传输的卡片。
      if (!busy.current && version === mutationVersion.current) {
        const destinations = changedCaptureDestinations(captureBaseline.current, result.tasks)
        captureBaseline.current = result.tasks
        if (!document.hidden && destinations.length) {
          const events = destinations.map((destination) => ({ id: ++captureSequence.current, destination }))
          // 同批次只按目的地合并流光，避免大量记录逐条播放形成积压。
          setCaptureOutputs((current) => [...current.filter((event) => !destinations.includes(event.destination)), ...events])
        }
        setState((current) => JSON.stringify(current.tasks) === JSON.stringify(result.tasks) ? current : { version: 1, tasks: result.tasks })
      }
      return result
    } catch (cause) { connectionError.current = true; setConnected(false); setError(cause instanceof Error ? cause.message : '工作台加载失败'); return null }
    finally { refreshing.current = false }
  }, [])
  const handleReportSaved = useCallback((report: DailyReport) => {
    setSnapshot((current) => current ? { ...current, dailyReports: mergeDailyReports(current.dailyReports ?? [], [report]).filter((entry) => entry.day === dateKey(new Date())) } : current)
  }, [])
  useEffect(() => {
    let disposed = false, ready = false
    const poller = createAdaptivePolling(async () => {
      const result = await refresh()
      if (!disposed) {
        setLoading(false)
        const now = new Date()
        // 页面只显示日期，不需要每半分钟更新时钟并重绘所有卡片。
        setClock((current) => dateKey(current) === dateKey(now) ? current : now)
      }
      return result ? { running: result.harness.run?.status === 'running' } : null
    }, () => !document.hidden)
    pollerRef.current = poller
    const resume = () => { if (ready) void poller.refreshNow() }
    const visibilityChanged = () => {
      setPageVisible(!document.hidden)
      if (document.hidden) setCaptureOutputs([])
      if (document.hidden) poller.pause()
      else resume()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('focus', resume)
    void (async () => {
      try { const migrationNotice = await migrateLegacyTasks(); if (!disposed) setNotice(migrationNotice) }
      catch (cause) { if (!disposed) setNotice(cause instanceof Error ? `旧记录暂未迁移：${cause.message}` : '旧记录暂未迁移，刷新页面后重试') }
      if (!disposed) { ready = true; await poller.refreshNow() }
    })()
    return () => {
      disposed = true; poller.stop(); pollerRef.current = null
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('focus', resume)
    }
  }, [refresh])
  useEffect(() => {
    if (!recentId) return
    const timer = window.setTimeout(() => setRecentId(null), 2500)
    return () => window.clearTimeout(timer)
  }, [recentId])
  const pending = useMemo(() => state.tasks.filter((task) => requiresManualCompletion(task.source) && !task.completedAt), [state.tasks])
  const completedCount = useMemo(() => recordsForDate(state, today).length, [state, today])
  const finishTransfer = useCallback((taskId: string) => {
    const saved = completedTask.current
    if (saved && saved.id === taskId) {
      setState((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? saved : task) }))
      captureBaseline.current = captureBaseline.current?.map((task) => task.id === taskId ? saved : task) ?? null
    }
    const now = new Date(); setClock(now); setRecentId(taskId)
    setPhase('idle'); setJob(null); setChangingId(null); completedTask.current = null; busy.current = false
    mutationVersion.current++
  }, [])
  const handleComplete = useCallback(async (task: Task, button: HTMLButtonElement) => {
    if (busy.current) return
    busy.current = true; mutationVersion.current++; setChangingId(task.id); setError(null)
    try {
      completedTask.current = await updateTask(task.id, true)
      if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.innerWidth < 1100 || !panelRef.current || !deckRef.current || !button.isConnected) { finishTransfer(task.id); return }
      const nextJob = createTransferJob(task.id, task.reference, button, processorRefs, panelRef.current, deckRef.current)
      if (!nextJob) { finishTransfer(task.id); return }
      setPhase('inbound'); setJob(nextJob)
    } catch (cause) { busy.current = false; setChangingId(null); setError(cause instanceof Error ? cause.message : '完成操作失败') }
  }, [finishTransfer, processorRefs])
  const handleAdd = useCallback(async (title: string) => {
    mutationVersion.current++
    setError(null)
    try { const task = await createTask(title); setState((current) => ({ ...current, tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)] })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '添加失败'); throw cause }
    finally { mutationVersion.current++ }
  }, [])
  const handleReopen = useCallback(async (task: Task) => {
    if (busy.current) return
    busy.current = true; mutationVersion.current++; setChangingId(task.id); setError(null)
    try {
      const saved = await updateTask(task.id, false)
      setState((current) => ({ ...current, tasks: [saved, ...current.tasks.filter((item) => item.id !== task.id)] }))
      captureBaseline.current = captureBaseline.current?.map((item) => item.id === task.id ? saved : item) ?? null
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '恢复操作失败') }
    finally { mutationVersion.current++; busy.current = false; setChangingId(null); void pollerRef.current?.refreshNow() }
  }, [])
  const finishCaptureOutput = useCallback((id: number) => {
    setCaptureOutputs((current) => current.filter((event) => event.id !== id))
  }, [])
  const handleDelete = useCallback(async (task: Task) => {
    if (busy.current || task.source !== 'manual' || task.completedAt) return
    busy.current = true; mutationVersion.current++; setDeletingId(task.id); setError(null)
    try {
      await deleteTask(task.id)
      setState((current) => ({ ...current, tasks: current.tasks.filter((item) => item.id !== task.id) }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败，请重试') }
    finally { mutationVersion.current++; busy.current = false; setDeletingId(null) }
  }, [])
  const handleSync = useCallback(async () => {
    setSyncRequested(true); setError(null)
    try { await startSync(); await pollerRef.current?.refreshNow() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '同步启动失败') }
    finally { setSyncRequested(false) }
  }, [])
  const handleSettingsSaved = useCallback((settings: WorkbenchSettings) => {
    setSnapshot((current) => current && { ...current, channels: settings.channels.map(({ paths: _paths, pathMode: _mode, ...channel }) => channel),
      harness: { ...current.harness, model: settings.model.name, intervalMs: settings.sync.intervalMs, autoSyncEnabled: settings.sync.enabled } })
    void pollerRef.current?.refreshNow()
  }, [])
  const status = job ? phaseLabels[phase] : recentId ? '✓ 已收进今天的日报' : loading ? '正在连接工作台服务' : phaseLabels.idle
  const routing = pageVisible && captureOutputs.length > 0
  const working = snapshot?.harness?.run?.status === 'running' || phase !== 'idle' || routing

  if (spaceOpen) {
    return (
      <div className={`app-shell is-space-mode${pageVisible ? '' : ' is-background'}`}>
        <Suspense fallback={<p role="status">正在打开个人空间…</p>}><PersonalSpace
          clock={clock}
          onClose={() => setSpaceOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        /></Suspense>
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={handleSettingsSaved} />}
      </div>
    )
  }

  return (
    <div className={`app-shell${pageVisible ? '' : ' is-background'}`}>
      <header className="top-bar">
        <div className="brand-section"><div className="brand-badge" aria-hidden="true"><img src="/icons/workbench-192.png" alt="" width="40" height="40" /></div><div className="brand-title"><h1>我的工作台</h1><p>汇聚待办，沉淀每一天的进展</p></div><span className={`live-indicator${connected ? '' : ' is-disconnected'}`} role="status"><span className="live-dot" aria-hidden="true" />{connected ? '本机工作台' : '服务未连接'}</span></div>
        <div className="top-meta">
          <PerpetualCalendar today={today} clock={clock} />
          <UserMenu
            onOpenSettings={() => setSettingsOpen(true)}
            onEnterSpace={() => setSpaceOpen(true)}
          />
        </div>
      </header>
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      {error && <p className="storage-notice request-error" role="alert">{error}<button onClick={() => { setError(null); void pollerRef.current?.refreshNow() }}>重新连接</button></p>}
      <main className={`stage-container${working ? ' is-working' : ''}`}>
        <svg className="idle-bus-layer" viewBox="0 0 1400 680" preserveAspectRatio="none" aria-hidden="true">{busPaths.map((path) => <path key={path} className="idle-track" d={path} />)}</svg>
        <TaskPanel tasks={pending} panelRef={panelRef} activeId={changingId} deletingId={deletingId} disabled={loading || !connected || changingId !== null || deletingId !== null} onAdd={handleAdd} onComplete={handleComplete} onDelete={handleDelete} />
        <ProcessorHub refs={processorRefs} phase={phase} routing={routing} activePin={job?.activePin ?? 0} pendingCount={pending.length} completedCount={completedCount} status={status} harness={snapshot?.harness} sources={snapshot?.sources} channels={snapshot?.channels} visible={pageVisible} onSync={handleSync} syncDisabled={loading || !connected || syncRequested} />
        <DailyLogBook recordedDayKeys={snapshot?.recordedDays} dataVersion={snapshot?.dataVersion} state={state} reports={snapshot?.dailyReports ?? []} onReportSaved={handleReportSaved} today={today} deckRef={deckRef} recentId={recentId} onReopen={handleReopen} disabled={!connected || changingId !== null || deletingId !== null} />
      </main>
      <footer className="app-footer"><span className={connected ? 'save-state' : 'save-state save-unavailable'} role="status"><Icon name="check" />{connected ? '记录保存在本机数据库' : '服务暂不可用，页面保留已加载记录'}</span><span>{snapshot?.harness.autoSyncEnabled === false ? '自动采集已暂停' : `每 ${(snapshot?.harness.intervalMs ?? 600000) / 60000} 分钟自动采集`}</span></footer>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={handleSettingsSaved} />}
      {job && <TransferLayer job={job} onPhase={setPhase} onDone={finishTransfer} />}
      {pageVisible && !job && captureOutputs.map((event) => <CaptureOutput key={event.id} event={event} chipRef={chip} panelRef={panelRef} deckRef={deckRef} onDone={finishCaptureOutput} />)}
    </div>
  )
}
