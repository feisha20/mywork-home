export interface PollActivity { running: boolean }

// 请求结束后再安排下一轮；SSE 活跃同步保留低频核对，避免漏掉完成事件后一直显示采集中。
export function createAdaptivePolling(refresh: () => Promise<PollActivity | null>, isVisible: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false, inFlight = false, pending = false, realtime = false, streamManaged = false, running = false
  let activityVersion = 0
  const pause = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; pending = false }
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (stopped || inFlight || !isVisible()) return
    const delay = pending ? 0 : realtime ? running ? 30000 : null : streamManaged ? 30000 : running ? 5000 : 30000
    pending = false
    if (delay !== null) timer = setTimeout(() => { void refreshNow() }, delay)
  }
  async function refreshNow() {
    if (stopped || !isVisible()) return
    if (inFlight) { pending = true; return }
    pause(); inFlight = true
    const version = activityVersion
    try {
      const activity = await refresh()
      // 刷新失败仍保留运行状态，继续核对，不能把连接失败当作同步完成。
      if (activity && version === activityVersion) running = activity.running
    }
    catch { /* 请求错误由页面展示，失败后继续低频重试。 */ }
    finally { inFlight = false; schedule() }
  }
  return { refreshNow, pause, setRealtime: (connected: boolean) => {
    realtime = connected; streamManaged = true; schedule()
  }, setActivity: (active: boolean) => { activityVersion++; running = active; schedule() }, stop: () => { stopped = true; pause() } }
}
