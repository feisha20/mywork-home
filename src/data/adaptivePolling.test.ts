import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdaptivePolling } from './adaptivePolling'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('工作台自适应轮询', () => {
  it('空闲每 30 秒读取，抽取中每 5 秒读取，结束后恢复空闲频率', async () => {
    let running = false
    const refresh = vi.fn(async () => ({ running }))
    const poller = createAdaptivePolling(refresh, () => true)
    await poller.refreshNow()
    await vi.advanceTimersByTimeAsync(29999); expect(refresh).toHaveBeenCalledTimes(1)
    running = true
    await vi.advanceTimersByTimeAsync(1); expect(refresh).toHaveBeenCalledTimes(2)
    running = false
    await vi.advanceTimersByTimeAsync(5000); expect(refresh).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(29999); expect(refresh).toHaveBeenCalledTimes(3)
    poller.stop()
  })
  it('切到后台后停止请求，回到前台立即刷新', async () => {
    let visible = true
    const refresh = vi.fn(async () => ({ running: true }))
    const poller = createAdaptivePolling(refresh, () => visible)
    await poller.refreshNow()
    visible = false; poller.pause()
    await vi.advanceTimersByTimeAsync(120000)
    await poller.refreshNow(); expect(refresh).toHaveBeenCalledTimes(1)
    visible = true; await poller.refreshNow(); expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })
  it('慢请求不会重叠，多次刷新请求合并为一次后续读取', async () => {
    let resolve!: (value: { running: boolean }) => void
    const refresh = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValue({ running: false })
    const poller = createAdaptivePolling(refresh, () => true)
    const first = poller.refreshNow()
    await poller.refreshNow(); await poller.refreshNow()
    await vi.advanceTimersByTimeAsync(60000); expect(refresh).toHaveBeenCalledTimes(1)
    resolve({ running: true }); await first
    await vi.advanceTimersByTimeAsync(0); expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })
  it('卸载时即使请求尚未结束，也不再安排轮询', async () => {
    let resolve!: (value: { running: boolean }) => void
    const refresh = vi.fn(() => new Promise<{ running: boolean }>((done) => { resolve = done }))
    const poller = createAdaptivePolling(refresh, () => true)
    const first = poller.refreshNow(); poller.stop()
    resolve({ running: true }); await first
    await vi.advanceTimersByTimeAsync(60000)
    expect(refresh).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it('请求失败后降低重试频率', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('连接失败'))
    const poller = createAdaptivePolling(refresh, () => true)
    await poller.refreshNow()
    await vi.advanceTimersByTimeAsync(29999); expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1); expect(refresh).toHaveBeenCalledTimes(2)
    poller.stop()
  })
  it('后台切换发生在请求过程中时，响应结束后也不启动计时器', async () => {
    let visible = true
    let resolve!: (value: { running: boolean }) => void
    const refresh = vi.fn(() => new Promise<{ running: boolean }>((done) => { resolve = done }))
    const poller = createAdaptivePolling(refresh, () => visible)
    const first = poller.refreshNow()
    visible = false; poller.pause()
    resolve({ running: true }); await first
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000); expect(refresh).toHaveBeenCalledOnce()
    poller.stop()
  })
})
