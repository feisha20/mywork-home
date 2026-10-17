export interface PollActivity { running: boolean }

// 请求结束后再安排下一轮；调用方决定是否允许后台轮询（例如开启待办通知时）。
export function createAdaptivePolling(refresh: () => Promise<PollActivity | null>, isVisible: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false, inFlight = false, pending = false, realtime = false, streamManaged = false
  const pause = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; pending = false }
  async function refreshNow() {
    if (stopped || !isVisible()) return
    if (inFlight) { pending = true; return }
    pause(); inFlight = true
    let running = false
    try { running = (await refresh())?.running ?? false }
    catch { /* 请求错误由页面展示，失败后按空闲频率重试。 */ }
    finally {
      inFlight = false
      if (!stopped && isVisible()) {
        const delay = pending ? 0 : realtime ? null : streamManaged ? 30000 : running ? 5000 : 30000
        pending = false
        if (delay !== null) timer = setTimeout(() => { void refreshNow() }, delay)
      }
    }
  }
  return { refreshNow, pause, setRealtime: (connected: boolean) => {
    realtime = connected
    streamManaged = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }, stop: () => { stopped = true; pause() } }
}
