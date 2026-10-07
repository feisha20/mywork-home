import { describe, expect, it } from 'vitest'
import type { Task } from './workbench'
import { createTaskNotificationTracker } from './taskNotifications'

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, reference: `TASK-${id}`, source: 'zentao', title: '测试待办',
  createdAt: '2026-10-07T00:00:00Z', completedAt: null, ...patch,
})

describe('禅道与计划任务新增通知', () => {
  it('首次加载静默，后续仅通知禅道与计划任务的未完成待办', () => {
    const track = createTaskNotificationTracker()
    const history = task('history')
    expect(track([history])).toEqual([])
    const zentao = task('zentao')
    const plan = task('plan', { source: 'manual', scheduledPlan: { id: 'daily', scheduledAt: '2026-10-07T01:00:00Z' } })
    expect(track([history, zentao, plan, task('manual', { source: 'manual' }),
      task('done', { completedAt: '2026-10-07T01:00:00Z' }), task('session', { source: 'codex' })])).toEqual([zentao, plan])
  })

  it('同一事项更新、消失后重现或完成后恢复均不会重复通知', () => {
    const track = createTaskNotificationTracker()
    track([])
    const incoming = task('new')
    expect(track([incoming])).toEqual([incoming])
    expect(track([{ ...incoming, title: '更新标题' }])).toEqual([])
    expect(track([])).toEqual([])
    expect(track([{ ...incoming, completedAt: '2026-10-07T01:00:00Z' }])).toEqual([])
    expect(track([incoming])).toEqual([])
  })

  it('空基线之后新增可提醒，已解决禅道 Bug 仍按待办规则提醒', () => {
    const track = createTaskNotificationTracker()
    track([])
    const bug = task('bug', { zentao: { type: 'bug', id: '1', instance: 'https://example.com', account: 'me',
      status: 'resolved', url: 'https://example.com/bug/1', priority: null, project: '', deadline: null } })
    expect(track([bug])).toEqual([bug])
  })
})
