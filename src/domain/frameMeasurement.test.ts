import { describe, expect, it, vi } from 'vitest'
import { createFrameMeasurement } from './frameMeasurement'

describe('动效尺寸测量合帧', () => {
  it('同帧多次 resize 只测量一次，下一帧可重新测量，卸载取消待执行帧', () => {
    const callbacks: FrameRequestCallback[] = [], measure = vi.fn(), cancel = vi.fn()
    const request = vi.fn((callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length })
    const scheduler = createFrameMeasurement(measure, request, cancel)
    scheduler.schedule(); scheduler.schedule(); scheduler.schedule()
    expect(request).toHaveBeenCalledOnce(); expect(measure).not.toHaveBeenCalled()
    callbacks[0](0); expect(measure).toHaveBeenCalledOnce()
    scheduler.schedule(); expect(request).toHaveBeenCalledTimes(2)
    scheduler.stop(); expect(cancel).toHaveBeenCalledWith(2)
    callbacks[1](0); scheduler.schedule()
    expect(measure).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(2)
  })
})
