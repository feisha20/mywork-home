// ResizeObserver 和窗口 resize 共用一帧测量，清理后不再访问已卸载元素。
export function createFrameMeasurement(measure: () => void,
  request: typeof requestAnimationFrame = requestAnimationFrame, cancel: typeof cancelAnimationFrame = cancelAnimationFrame) {
  let frame: number | undefined, stopped = false
  return {
    schedule() {
      if (stopped || frame !== undefined) return
      frame = request(() => { frame = undefined; if (!stopped) measure() })
    },
    stop() { stopped = true; if (frame !== undefined) cancel(frame); frame = undefined },
  }
}
