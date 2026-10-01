import { useEffect, useRef } from 'react'
import { animate } from 'motion'
import type { ProcessorRefs, TransferPhase } from './ProcessorHub'

export interface TransferJob {
  taskId: string
  reference: string
  activePin: number
  paths: [string, string, string]
  width: number
  height: number
}

export function createTransferJob(taskId: string, reference: string, button: HTMLButtonElement, refs: ProcessorRefs, panel: HTMLElement, deck: HTMLDivElement): TransferJob | null {
  if (!refs.chip.current || !refs.ring.current || !refs.rightPin.current || refs.leftPins.some((ref) => !ref.current)) return null
  const start = button.getBoundingClientRect()
  const startX = start.right
  const startY = start.top + start.height / 2
  const pinRects = refs.leftPins.map((ref) => ref.current!.getBoundingClientRect())
  const activePin = pinRects.reduce((closest, pin, index) => Math.abs(pin.top + pin.height / 2 - startY) < Math.abs(pinRects[closest].top + pinRects[closest].height / 2 - startY) ? index : closest, 0)
  const leftPin = pinRects[activePin]
  const rightPin = refs.rightPin.current.getBoundingClientRect()
  const chip = refs.chip.current.getBoundingClientRect()
  const ring = refs.ring.current.getBoundingClientRect()
  const destination = deck.getBoundingClientRect()
  const targetX = destination.left + 23
  const targetY = destination.top + 81
  const gutterX = panel.getBoundingClientRect().right + 12
  const radius = 28
  const middleY = ring.top + ring.height / 2
  return {
    taskId, reference, activePin,
    width: window.innerWidth, height: window.innerHeight,
    paths: [
      `M ${startX} ${startY} L ${gutterX} ${startY} L ${gutterX + 12} ${leftPin.top + leftPin.height / 2} L ${leftPin.left} ${leftPin.top + leftPin.height / 2}`,
      `M ${ring.left} ${middleY} L ${ring.left} ${ring.top + radius} A ${radius} ${radius} 0 0 1 ${ring.left + radius} ${ring.top} L ${ring.right - radius} ${ring.top} A ${radius} ${radius} 0 0 1 ${ring.right} ${ring.top + radius} L ${ring.right} ${ring.bottom - radius} A ${radius} ${radius} 0 0 1 ${ring.right - radius} ${ring.bottom} L ${ring.left + radius} ${ring.bottom} A ${radius} ${radius} 0 0 1 ${ring.left} ${ring.bottom - radius} L ${ring.left} ${middleY}`,
      `M ${rightPin.right} ${rightPin.top + rightPin.height / 2} L ${chip.right + 20} ${rightPin.top + rightPin.height / 2} L ${chip.right + 36} ${targetY} L ${targetX} ${targetY}`,
    ],
  }
}

interface TransferLayerProps {
  job: TransferJob
  onPhase: (phase: TransferPhase) => void
  onDone: (taskId: string) => void
}

// 动效只操作自己的 SVG 图层，任务记录由上层状态统一管理。
export function TransferLayer({ job, onPhase, onDone }: TransferLayerProps) {
  const pathRefs = useRef<(SVGPathElement | null)[]>([])
  const groupRefs = useRef<(SVGGElement | null)[]>([])

  useEffect(() => {
    let cancelled = false
    let completed = false
    let stop: (() => void) | undefined
    const finish = () => {
      if (cancelled || completed) return
      completed = true
      stop?.()
      onDone(job.taskId)
    }
    async function run() {
      const phases: TransferPhase[] = ['inbound', 'orbit', 'outbound']
      const durations = [0.55, 0.72, 0.55]
      try {
        for (let index = 0; index < job.paths.length; index++) {
          if (cancelled || completed) return
          const path = pathRefs.current[index]
          const group = groupRefs.current[index]
          if (!path || !group) { finish(); return }
          const length = path.getTotalLength()
          const particles = [...group.children] as SVGCircleElement[]
          const start = path.getPointAtLength(0)
          particles.forEach((particle) => particle.setAttribute('transform', `translate(${start.x}, ${start.y})`))
          group.style.opacity = '1'
          onPhase(phases[index])
          const animation = animate(0, 1, {
            duration: durations[index],
            ease: 'linear',
            onUpdate: (progress) => {
              particles.forEach((particle, particleIndex) => {
                const point = path.getPointAtLength(Math.max(0, progress * length - particleIndex * 11))
                particle.setAttribute('transform', `translate(${point.x}, ${point.y})`)
              })
            },
          })
          stop = () => animation.stop()
          await animation
          group.style.opacity = '0'
        }
        finish()
      } catch {
        finish()
      }
    }
    void run()
    // 布局变化时直接完成任务，避免旧坐标的轨迹停留在页面上。
    window.addEventListener('resize', finish)
    window.addEventListener('scroll', finish, true)
    return () => {
      cancelled = true
      stop?.()
      window.removeEventListener('resize', finish)
      window.removeEventListener('scroll', finish, true)
    }
  }, [job, onPhase, onDone])

  return (
    <svg className="transfer-layer" viewBox={`0 0 ${job.width} ${job.height}`} aria-hidden="true">
      {job.paths.map((path, index) => (
        <g key={index}>
          <path d={path} ref={(node) => { pathRefs.current[index] = node }} className={index === 1 ? 'photon-orbit-guide' : 'photon-track-guide'} />
          <g ref={(node) => { groupRefs.current[index] = node }} opacity="0">
            {Array.from({ length: 7 }, (_, particle) => <circle key={particle} className="photon-particle" r={particle === 0 ? 5 : Math.max(1.8, 4.2 - particle * 0.55)} opacity={1 - particle * 0.12} />)}
          </g>
        </g>
      ))}
    </svg>
  )
}
