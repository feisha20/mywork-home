import type { WorkbenchEvents } from '../../shared/events'

interface EventStream {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
}
interface RealtimeCallbacks {
  connection: (connected: boolean) => void
  changed: () => void
  status: (status: WorkbenchEvents['sync:progress']) => void
}

// 重连成功总是补读快照，弥补断线窗口；不依赖内存事件历史或重复执行写操作。
export function subscribeWorkbenchEvents(callbacks: RealtimeCallbacks,
  factory: (() => EventStream) | undefined = typeof EventSource === 'undefined' ? undefined : () => new EventSource('/api/events')) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  let connected: boolean | undefined
  const refresh = () => {
    if (stopped || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; if (!stopped) callbacks.changed() }, 80)
  }
  if (!factory) { callbacks.connection(false); return () => {} }
  let stream: EventStream
  try { stream = factory() }
  catch { callbacks.connection(false); return () => {} }
  stream.onopen = () => {
    if (stopped) return
    connected = true
    callbacks.connection(true); refresh()
  }
  stream.onerror = () => {
    if (stopped) return
    // 浏览器可能每隔数秒重试失败；只在状态转为断开时唤醒一次兜底刷新。
    if (connected === false) return
    connected = false
    callbacks.connection(false); refresh()
    // 保留 EventSource 自带的重连；主动 close 会阻止浏览器重试。
  }
  for (const name of ['workbench:changed', 'tasks:created']) stream.addEventListener(name, refresh)
  for (const name of ['sync:progress', 'model:failover', 'model:changed']) stream.addEventListener(name, (event) => {
    if (stopped) return
    try {
      const status = JSON.parse(event.data) as WorkbenchEvents['sync:progress']
      if (!status.harness || !status.modelRuntime) throw new Error('状态事件不完整')
      callbacks.status(status)
      if (name === 'sync:progress' && status.harness.run?.status !== 'running') refresh()
    } catch {
      // 异常帧通过快照恢复，不将未知数据写入页面状态。
      refresh()
    }
  })
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    stream.onopen = null; stream.onerror = null; stream.close()
  }
}
