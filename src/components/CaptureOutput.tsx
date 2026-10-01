import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { CaptureDestination } from '../domain/captureFlow'

export interface CaptureOutputEvent { id: number; destination: CaptureDestination }

interface CaptureOutputProps {
  event: CaptureOutputEvent
  chipRef: RefObject<HTMLDivElement | null>
  panelRef: RefObject<HTMLElement | null>
  deckRef: RefObject<HTMLDivElement | null>
  onDone: (id: number) => void
}

// 流光只在收到实际同步结果后播放一轮，不与采集轮询绑定成常驻循环。
export function CaptureOutput({ event, chipRef, panelRef, deckRef, onDone }: CaptureOutputProps) {
  const [geometry, setGeometry] = useState<{ path: string; width: number; height: number } | null>(null)
  useEffect(() => {
    const chip = chipRef.current
    const target = event.destination === 'tasks' ? panelRef.current?.querySelector('.task-container') : deckRef.current
    const finish = () => onDone(event.id)
    if (!chip || !target || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return }
    const start = chip.getBoundingClientRect(), end = target.getBoundingClientRect()
    let path: string
    if (end.right <= start.left || end.left >= start.right) {
      const left = end.right <= start.left
      const fromX = left ? start.left - 4 : start.right + 4
      const toX = left ? end.right - 12 : end.left + 12
      const fromY = start.top + start.height / 2, toY = end.top + 28
      const elbow = fromX + (left ? -18 : 18), bevel = left ? -8 : 8
      const vertical = Math.sign(toY - fromY)
      const corner = Math.min(8, Math.abs(toY - fromY) / 2)
      path = `M ${fromX} ${fromY} L ${elbow} ${fromY} L ${elbow + bevel} ${fromY + vertical * corner} L ${elbow + bevel} ${toY - vertical * corner} L ${elbow + bevel * 2} ${toY} L ${toX} ${toY}`
    } else {
      // 窄窗口按上下顺序连接，保留与背景相同的折线形态。
      const above = end.bottom <= start.top
      const fromX = start.left + start.width / 2, fromY = above ? start.top - 4 : start.bottom + 4
      const toX = end.left + end.width / 2, toY = above ? end.bottom - 12 : end.top + 12
      const middle = (fromY + toY) / 2
      path = `M ${fromX} ${fromY} L ${fromX} ${middle} L ${toX} ${middle} L ${toX} ${toY}`
    }
    setGeometry({ path, width: window.innerWidth, height: window.innerHeight })
    // 计时兜底；后台、滚动或布局变化直接结束，避免旧坐标残留。
    const timer = window.setTimeout(finish, 2400)
    const visibilityChanged = () => { if (document.hidden) finish() }
    window.addEventListener('resize', finish)
    window.addEventListener('scroll', finish, true)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', finish)
      window.removeEventListener('scroll', finish, true)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [event, chipRef, panelRef, deckRef, onDone])
  if (!geometry) return null
  return <svg className="transfer-layer capture-output-layer" viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-hidden="true">
    <path className="capture-output-track" d={geometry.path} />
    <path className="capture-output-beam" d={geometry.path} pathLength="540" onAnimationEnd={() => onDone(event.id)} />
  </svg>
}
