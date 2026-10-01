import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

interface SourceTransferProps {
  frameRef: RefObject<HTMLElement | null>
  sourceRef: RefObject<HTMLDivElement | null>
  targetRef: RefObject<HTMLDivElement | null>
}

// 使用工作流区域的实际坐标，连线在窗口缩放和布局切换后仍对准来源与芯片。
export function SourceTransfer({ frameRef, sourceRef, targetRef }: SourceTransferProps) {
  const [geometry, setGeometry] = useState<{ path: string; width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const frame = frameRef.current, source = sourceRef.current, target = targetRef.current
    if (!frame || !source || !target) return
    const measure = () => {
      const bounds = frame.getBoundingClientRect(), from = source.getBoundingClientRect(), to = target.getBoundingClientRect()
      let path: string
      if (from.left >= to.right) {
        const x1 = from.left - bounds.left, y1 = from.top + from.height / 2 - bounds.top
        const x2 = to.right - bounds.left, y2 = to.top + to.height / 2 - bounds.top
        const middle = (x1 + x2) / 2, direction = Math.sign(y2 - y1)
        const corner = Math.min(12, Math.abs(y2 - y1) / 2, (x1 - x2) / 4)
        path = `M ${x1} ${y1} L ${middle + corner} ${y1} L ${middle} ${y1 + direction * corner} L ${middle} ${y2 - direction * corner} L ${middle - corner} ${y2} L ${x2} ${y2}`
      } else {
        // 从卡片外侧绕行，避免 Codex 的光束穿过上方的禅道卡片。
        const left = from.left + from.width / 2 < to.left + to.width / 2
        const x1 = (left ? from.left : from.right) - bounds.left, y1 = from.top + from.height / 2 - bounds.top
        const x2 = (left ? to.left : to.right) - bounds.left, y2 = to.top + to.height / 2 - bounds.top
        const lane = left ? Math.min(x1, x2) - 24 : Math.max(x1, x2) + 24
        const corner = Math.min(12, Math.abs(y1 - y2) / 2), direction = Math.sign(y2 - y1)
        const elbow = lane + (left ? corner : -corner)
        path = `M ${x1} ${y1} L ${elbow} ${y1} L ${lane} ${y1 + direction * corner} L ${lane} ${y2 - direction * corner} L ${elbow} ${y2} L ${x2} ${y2}`
      }
      setGeometry({ path, width: bounds.width, height: bounds.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame); observer.observe(source); observer.observe(target)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [frameRef, sourceRef, targetRef])

  if (!geometry) return null
  return (
    <svg className="source-transfer-layer" viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-hidden="true">
      <path className="source-transfer-track" d={geometry.path} />
      <path className="source-transfer-beam" d={geometry.path} pathLength="540" />
    </svg>
  )
}
