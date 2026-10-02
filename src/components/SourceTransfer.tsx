import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { WorkbenchSnapshot } from '../../shared/contracts'
import { channelStatus, type CaptureSource, type ChannelSlot } from '../domain/channelDock'

interface SourceTransferProps {
  slots: ChannelSlot[]
  frameRef: RefObject<HTMLElement | null>
  sourceRefs: RefObject<HTMLDivElement | null>[]
  sourcePorts: RefObject<HTMLSpanElement | null>[]
  bottomPins: RefObject<HTMLSpanElement | null>[]
  targetRef: RefObject<HTMLDivElement | null>
  activeSource: CaptureSource | null
  sources?: WorkbenchSnapshot['sources']
  runErrors?: readonly string[]
  working: boolean
  visible: boolean
}
interface Point { x: number; y: number }
interface Circuit { slot: ChannelSlot; path: string; start: Point; end: Point; connected: boolean; active: boolean }

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

// 每个渠道常驻一条电路线；已接入渠道具有绿色脉冲动态传输，采集中加速并高亮，未接入保持静态待机。
export function SourceTransfer({ slots, frameRef, sourceRefs, sourcePorts, bottomPins, targetRef, activeSource, sources, runErrors, working, visible }: SourceTransferProps) {
  const [geometry, setGeometry] = useState<{ circuits: Circuit[]; width: number; height: number } | null>(null)
  const layerRef = useRef<SVGSVGElement>(null)
  // 被动副作用执行时，父级和兄弟元素的引用已经就绪。
  useEffect(() => {
    if (!visible) return
    const frame = frameRef.current, target = targetRef.current, layer = layerRef.current
    const elements = sourceRefs.map((ref) => ref.current)
    const ports = sourcePorts.map((ref) => ref.current)
    const pins = bottomPins.map((ref) => ref.current)
    if (!slots.length || !frame || !target || !layer || [...elements, ...ports, ...pins].some((element) => !element)) return
    const matrix = frame.querySelector('.engine-matrix-wrap')
    if (!matrix) return
    const measure = () => {
      // SVG 自身是坐标原点，避免父容器内边距或视口缩放引入偏移。
      const bounds = layer.getBoundingClientRect(), chip = target.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const cards = elements.map((element) => element!.getBoundingClientRect())
      const leftEdge = Math.min(...cards.map((card) => card.left))
      const horizontal = leftEdge >= chip.right
      const matrixLeft = matrix.getBoundingClientRect().left - bounds.left
      const circuits = slots.map((slot, index): Circuit => {
        const port = ports[index]!.getBoundingClientRect(), pin = pins[index]!.getBoundingClientRect()
        const start = { x: port.left + port.width / 2 - bounds.left, y: port.top + port.height / 2 - bounds.top }
        const end = { x: pin.left + pin.width / 2 - bounds.left, y: pin.bottom - bounds.top }
        // 单排入口与引脚保持同序；外侧线先收拢，避免交叉或穿过 Logo。
        const clearance = Math.max(12, Math.min(30, (start.y - end.y) / 2))
        const bridge = end.y + Math.max(8, clearance - Math.abs(index - (slots.length - 1) / 2) * 5)
        const gutter = Math.max(chip.right - bounds.left + 6, matrixLeft - 8 - index * 4)
        const topLane = start.y - 8 - index * 4, bottomLane = end.y + 8 + (slots.length - 1 - index) * 4
        const points = horizontal
          ? [start, { x: start.x, y: topLane }, { x: gutter, y: topLane }, { x: gutter, y: bottomLane }, { x: end.x, y: bottomLane }, end]
          : [start, { x: start.x, y: bridge }, { x: end.x, y: bridge }, end]
        // 检查当前渠道是否已接入
        const states = slot.sources.map((entry) => channelStatus(entry, sources, activeSource, runErrors))
        const connected = states.some((entry) => entry.kind === 'connected' || entry.kind === 'warning' || entry.kind === 'active')
        const active = !!activeSource && slot.sources.includes(activeSource)
        // 路径起点固定为采集渠道，终点固定为芯片；递减偏移沿起点向终点传输。
        return { slot, path: circuitPath(points), start: points[0], end: points.at(-1)!, connected, active }
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
  }, [slots, frameRef, sourceRefs, sourcePorts, bottomPins, targetRef, activeSource, sources, runErrors, visible])

  return <svg ref={layerRef} className={`source-transfer-layer${working ? ' is-working' : ''}`} viewBox={geometry ? `0 0 ${geometry.width} ${geometry.height}` : undefined} preserveAspectRatio="none" aria-hidden="true">
    {geometry?.circuits.map((circuit, index) => {
      const isCircuitActive = visible && circuit.active
      const isConnected = circuit.connected
      const classNames = [
        'source-circuit-group',
        isConnected ? 'is-connected' : 'is-pending',
        isCircuitActive ? 'circuit-active' : '',
      ].filter(Boolean).join(' ')

      return (
        <g key={circuit.slot.id} className={classNames}>
          <path className="source-transfer-track" d={circuit.path} />
          <circle className="circuit-terminal" cx={circuit.end.x} cy={circuit.end.y} r="2.5" />
          {visible && isConnected && (
            <path
              className="source-transfer-beam"
              d={circuit.path}
              pathLength="540"
              style={{ animationDelay: `${-index * (working ? 0.8 : 2.5)}s` }}
            />
          )}
        </g>
      )
    })}
  </svg>
}
