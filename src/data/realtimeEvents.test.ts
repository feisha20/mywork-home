import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeWorkbenchEvents } from './realtimeEvents'
import { createAdaptivePolling } from './adaptivePolling'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function stream() {
  const listeners = new Map<string, (event: MessageEvent) => void>()
  return { onopen: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null,
    addEventListener: (name: string, listener: (event: MessageEvent) => void) => listeners.set(name, listener), close: vi.fn(),
    emit: (name: string, data = '{}') => listeners.get(name)?.({ data } as MessageEvent) }
}
describe('工作台实时订阅与轮询降级', () => {
  it('连通后停止周期请求，断线低频刷新，重连补读快照且不叠加连接', async () => {
    const source = stream(), refresh = vi.fn(async () => ({ running: true }))
    const poller = createAdaptivePolling(refresh, () => true)
    const stop = subscribeWorkbenchEvents({ connection: poller.setRealtime, changed: () => { void poller.refreshNow() }, status: vi.fn() }, () => source)
    source.onopen?.({} as Event)
    await vi.advanceTimersByTimeAsync(80)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120000)
    expect(refresh).toHaveBeenCalledOnce()
    source.onerror?.({} as Event)
    await vi.advanceTimersByTimeAsync(80)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(source.close).not.toHaveBeenCalled()
    source.onerror?.({} as Event); source.onerror?.({} as Event)
    await vi.advanceTimersByTimeAsync(29999)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(3)
    source.onopen?.({} as Event)
    await vi.advanceTimersByTimeAsync(80)
    await vi.advanceTimersByTimeAsync(120000)
    expect(refresh).toHaveBeenCalledTimes(4)
    stop(); poller.stop()
    expect(source.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('同批变更合并请求，模型及渠道进度直接更新，非法帧补读快照', async () => {
    const source = stream(), callbacks = { connection: vi.fn(), changed: vi.fn(), status: vi.fn() }
    const stop = subscribeWorkbenchEvents(callbacks, () => source)
    source.emit('tasks:created'); source.emit('workbench:changed'); source.emit('workbench:changed')
    const status = { harness: { run: { status: 'running', activeSource: 'codex' } }, modelRuntime: { activeModelIds: ['backup'] } }
    source.emit('model:failover', JSON.stringify(status))
    expect(callbacks.status).toHaveBeenCalledWith(status)
    source.emit('sync:progress', 'invalid')
    await vi.advanceTimersByTimeAsync(80)
    expect(callbacks.changed).toHaveBeenCalledOnce()
    stop()
    source.emit('tasks:created')
    await vi.advanceTimersByTimeAsync(80)
    expect(callbacks.changed).toHaveBeenCalledOnce()
  })
  it('刷新未完成时连上 SSE，不再安排后台轮询；事件仍能排队补读', async () => {
    let resolve!: (value: { running: boolean }) => void
    const refresh = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValue({ running: true })
    const poller = createAdaptivePolling(refresh, () => true)
    const pending = poller.refreshNow()
    poller.setRealtime(true); await poller.refreshNow()
    resolve({ running: true }); await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(120000)
    expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })
  it('不支持 EventSource 或构造失败时启用降级', () => {
    const callbacks = { connection: vi.fn(), changed: vi.fn(), status: vi.fn() }
    subscribeWorkbenchEvents(callbacks, () => { throw new Error('不支持') })()
    expect(callbacks.connection).toHaveBeenCalledWith(false)
  })
})
