import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { SourceId } from '../domain/workbench'
import { CAPTURE_SOURCES } from '../domain/workbench'

export type CaptureSource = Exclude<SourceId, 'manual'>
export type CaptureRefs<T extends HTMLElement = HTMLDivElement> = Record<CaptureSource, RefObject<T | null>>
interface SourceTransferProps {
  frameRef: RefObject<HTMLElement | null>
  sourceRefs: CaptureRefs
  sourcePorts: CaptureRefs<HTMLSpanElement>
  bottomPins: CaptureRefs<HTMLSpanElement>
  targetRef: RefObject<HTMLDivElement | null>
  activeSource: CaptureSource | null
  working: boolean
  visible: boolean
}
interface Point { x: number; y: number }
interface Circuit { source: CaptureSource; path: string; start: Point; end: Point }
const channels = CAPTURE_SOURCES

// 折角使用短斜线，与背景电路线保持一致。
function circuitPath(points: Point[]): string {
  const route = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  let path = `M ${route[0].x} ${route[0].y}`
  for (let index = 1; index < route.length - 1; index++) {
    const before = route[index - 1], point = route[index], after = route[index + 1]
    const incoming = Math.hypot(point.x - before.x, point.y - before.y)
    const outgoing = Math.hypot(after.x - point.x, after.y - point.y)
    const corner = Math.min(8, incoming / 2, outgoing / 2)
    path += ` L ${point.x - (point.x - before.x) * corner / incoming} ${point.y - (point.y - before.y) * corner / incoming}`
    path += ` L ${point.x + (after.x - point.x) * corner / outgoing} ${point.y + (after.y - point.y) * corner / outgoing}`
  }
  const end = route.at(-1)!
  return `${path} L ${end.x} ${end.y}`
}

// 每个渠道常驻一条电路线；空闲缓流、采集加速，后台停止测量和流光。
export function SourceTransfer({ frameRef, sourceRefs, sourcePorts, bottomPins, targetRef, activeSource, working, visible }: SourceTransferProps) {
  const [geometry, setGeometry] = useState<{ circuits: Circuit[]; width: number; height: number } | null>(null)
  const layerRef = useRef<SVGSVGElement>(null)
  // 被动副作用执行时，父级和兄弟元素的引用已经就绪。
  useEffect(() => {
    if (!visible) return
    const frame = frameRef.current, target = targetRef.current, layer = layerRef.current
    const elements = channels.map((source) => sourceRefs[source].current)
    const ports = channels.map((source) => sourcePorts[source].current)
    const pins = channels.map((source) => bottomPins[source].current)
    if (!frame || !target || !layer || [...elements, ...ports, ...pins].some((element) => !element)) return
    const matrix = frame.querySelector('.engine-matrix-wrap')
    if (!matrix) return
    const measure = () => {
      // SVG 自身是坐标原点，避免父容器内边距或视口缩放引入偏移。
      const bounds = layer.getBoundingClientRect(), chip = target.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const cards = elements.map((element) => element!.getBoundingClientRect())
      const leftEdge = Math.min(...cards.map((card) => card.left)), rightEdge = Math.max(...cards.map((card) => card.right))
      const horizontal = leftEdge >= chip.right
      const matrixBottom = matrix.getBoundingClientRect().bottom - bounds.top
      const firstRowTop = Math.min(...cards.map((card) => card.top)) - bounds.top
      const circuits = channels.map((source, index): Circuit => {
        const columnLeft = index % 2 === 0, row = Math.floor(index / 2)
        const port = ports[index]!.getBoundingClientRect(), pin = pins[index]!.getBoundingClientRect()
        const start = { x: port.left + port.width / 2 - bounds.left, y: port.top + port.height / 2 - bounds.top }
        const end = { x: pin.left + pin.width / 2 - bounds.left, y: pin.bottom - bounds.top }
        // 后续各排逐渐走外侧，上排走内侧。
        const spacing = 12 + row * 8
        const lane = (columnLeft ? leftEdge - spacing : rightEdge + spacing) - bounds.left
        const gapBelowChip = firstRowTop - end.y
        // 外侧线路在较高的位置收拢，内侧线路在较低的位置收拢，避免交叉。
        const clearance = Math.max(12, Math.min(28, gapBelowChip - 8))
        const bridge = horizontal ? Math.max(end.y, matrixBottom) + (Math.ceil(channels.length / 2) - row) * 8 : end.y + clearance * Math.pow(.6, row)
        const points = [start, { x: lane, y: start.y }, { x: lane, y: bridge }, { x: end.x, y: bridge }, end]
        // 路径起点固定为采集渠道，终点固定为芯片；递减偏移沿起点向终点传输。
        return { source, path: circuitPath(points), start: points[0], end: points.at(-1)! }
      })
      const next = { circuits, width: bounds.width, height: bounds.height }
      setGeometry((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame); observer.observe(target); observer.observe(layer)
    for (const element of [...elements, ...ports, ...pins]) observer.observe(element!)
    // 状态文案高度变化会移动整组卡片，即使卡片自身尺寸没有变化。
    frame.querySelectorAll('.hub-top-hud, .chip-carrier-board, .engine-matrix-wrap').forEach((element) => observer.observe(element))
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [frameRef, sourceRefs, sourcePorts, bottomPins, targetRef, visible])

  return <svg ref={layerRef} className={`source-transfer-layer${working ? ' is-working' : ''}`} viewBox={geometry ? `0 0 ${geometry.width} ${geometry.height}` : undefined} preserveAspectRatio="none" aria-hidden="true">
    {geometry?.circuits.map((circuit, index) => <g key={circuit.source} className={visible && circuit.source === activeSource ? 'circuit-active' : undefined}>
      <path className="source-transfer-track" d={circuit.path} />
      <circle className="circuit-terminal" cx={circuit.end.x} cy={circuit.end.y} r="2.5" />
      {visible && <path className="source-transfer-beam" d={circuit.path} pathLength="540" style={{ animationDelay: `${-index * (working ? 1 : 4)}s` }} />}
    </g>)}
  </svg>
}
