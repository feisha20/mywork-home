import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef } from 'react'
import { ScheduledTaskDate } from './ScheduledTaskDate'
import { LogRecords } from './LogRecords'
import { TaskPanel } from './TaskPanel'
import type { Task } from '../domain/workbench'

const task: Task = { id: 'weekly', reference: 'PLAN-WEEKLY', source: 'manual', title: '提交周报',
  createdAt: '2026-10-16T09:30:00Z', completedAt: '2026-10-19T01:48:00Z', recordedAt: '2026-10-16T09:30:00Z',
  scheduledPlan: { id: 'plan', scheduledAt: '2026-10-16T09:30:00Z' } }

describe('计划报告待办日期说明', () => {
  it('周一补交时展示归属周五的日期和实际完成日期', () => {
    const html = renderToStaticMarkup(<ScheduledTaskDate task={task} />)
    expect(html).toContain('归属日期：'); expect(html).toContain('2026-10-16（周五）')
    expect(html).toContain('计划 17:30'); expect(html).toContain('实际完成：')
    expect(html).toContain('2026-10-19'); expect(html).toContain('09:48')
    expect(renderToStaticMarkup(<ScheduledTaskDate task={{ ...task, scheduledPlan: null }} />)).toBe('')
  })
  it('待办和完成后的日志都标出计划日期，日志保留实际完成时间', () => {
    const onTogglePersonal = async (entry: Task) => entry
    const pending = renderToStaticMarkup(<TaskPanel tasks={[{ ...task, completedAt: null }]} panelRef={createRef<HTMLElement>()}
      activeId={null} deletingId={null} pinningId={null} onTogglePinned={async () => {}} onAdd={async () => {}}
      onTogglePersonal={onTogglePersonal} onComplete={() => {}} onDelete={() => {}} onIgnore={() => {}} />)
    const completed = renderToStaticMarkup(<LogRecords records={[task]} disabled={false} onReopen={() => {}} onTogglePersonal={onTogglePersonal} />)
    for (const html of [pending, completed]) {
      expect(html).toContain('2026-10-16（周五）'); expect(html).toContain('计划任务'); expect(html).toContain('提交周报')
    }
    expect(completed).toContain('dateTime="2026-10-19T01:48:00Z"')
    expect(completed).not.toContain('手动添加')
  })
})
