import { describe, expect, it } from 'vitest'
import { addTask, pendingTasks, canManualComplete, completeTask, createDemoState, dateKey, decodeSnapshot, recentWorkdays, recordsForDate, recordTimestamp, requiresManualCompletion } from './workbench'

const today = new Date('2026-09-30T14:00:00+08:00')
const fixture = () => {
  const state = createDemoState(today)
  return { ...state, tasks: state.tasks.filter((task) => task.completedAt || requiresManualCompletion(task.source)) }
}

describe('工作台记录', () => {
  it('多个禅道和自定义待办可置顶，取消后回到时间顺序，已完成和自动记录不进入待办', () => {
    const base = fixture().tasks[0]
    const manual = { ...base, id: 'manual-pin', source: 'manual' as const, createdAt: '2026-09-20T01:00:00Z', isPinned: true }
    const bug = { ...base, id: 'bug-pin', reference: 'BUG-1', createdAt: '2026-09-21T01:00:00Z', isPinned: true }
    const recent = { ...manual, id: 'recent', createdAt: '2026-09-30T01:00:00Z', isPinned: false }
    const older = { ...manual, id: 'older', createdAt: '2026-09-19T01:00:00Z', isPinned: undefined }
    const tasks = [recent, manual, older, bug, { ...bug, id: 'done', completedAt: today.toISOString() }, { ...manual, id: 'auto', source: 'codex' as const }]
    expect(pendingTasks(tasks).map((task) => task.id)).toEqual(['bug-pin', 'manual-pin', 'recent', 'older'])
    expect(tasks[0]).toBe(recent)
    expect(pendingTasks(tasks.map((task) => task.id === manual.id ? { ...task, isPinned: false } : task)).map((task) => task.id)).toEqual(['bug-pin', 'recent', 'manual-pin', 'older'])
    const pinned = { version: 1 as const, tasks: [manual, bug] }
    expect(decodeSnapshot(JSON.stringify(pinned))).toEqual(pinned)
    expect(decodeSnapshot(JSON.stringify({ ...pinned, tasks: [{ ...manual, isPinned: 'true' }] }))).toBeNull()
  })

  it('跨周末与月界仍能生成最近工作日', () => {
    expect(recentWorkdays(new Date('2026-09-01T00:00:00+08:00'))).toEqual(['2026-09-01', '2026-08-31', '2026-08-28', '2026-08-27'])
  })

  it('同一任务只归档一次，原状态保持不变', () => {
    const initial = fixture()
    const task = initial.tasks.find((item) => !item.completedAt)!
    const completed = completeTask(initial, task.id, today)
    expect(recordsForDate(completed, dateKey(today))).toHaveLength(3)
    expect(initial.tasks.find((item) => item.id === task.id)?.completedAt).toBeNull()
    expect(completeTask(completed, task.id, new Date(2026, 9, 1))).toBe(completed)
    expect(completeTask(completed, '不存在的任务', today)).toBe(completed)
  })

  it('跨日归档进入完成当天，保留历史记录', () => {
    const initial = fixture()
    const tomorrow = new Date('2026-10-01T00:01:00+08:00')
    const completed = completeTask(initial, initial.tasks[0].id, tomorrow)
    expect(recordsForDate(completed, '2026-09-30')).toHaveLength(2)
    expect(recordsForDate(completed, '2026-10-01')[0].id).toBe(initial.tasks[0].id)
  })

  it('新增任务修剪空白，拒绝空内容、过长内容与重复标识', () => {
    const initial = fixture()
    const added = addTask(initial, '  整理接口回归结果  ', 'new-task', today)
    expect(added.tasks[0].title).toBe('整理接口回归结果')
    expect(added.tasks[0].completedAt).toBeNull()
    expect(addTask(initial, '   ', 'blank', today)).toBe(initial)
    expect(addTask(initial, '字'.repeat(301), 'long', today)).toBe(initial)
    expect(addTask(added, '另一项', 'new-task', today)).toBe(added)
  })

  it('缓存往返保持完整，损坏数据不会进入页面', () => {
    const initial = fixture()
    expect(decodeSnapshot(JSON.stringify(initial))).toEqual(initial)
    expect(decodeSnapshot('{不完整')).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ ...initial, version: 2 }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [{ ...initial.tasks[0], source: '未知工具' }] }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [{ ...initial.tasks[0], completedAt: '非日期' }] }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [{ ...initial.tasks[0], recordedAt: '非日期' }] }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [initial.tasks[0], initial.tasks[0]] }))).toBeNull()
  })

  it('归档列表按完成时间排序', () => {
    const initial = fixture()
    const completed = completeTask(initial, initial.tasks[0].id, today)
    expect(recordsForDate(completed, dateKey(today)).map((task) => task.reference)).toEqual(['TASK-20489', 'SESSION-882', 'TASK-1002'])
  })
  it('不同宿主机时区均以北京时间划分日报', () => {
    expect(dateKey(new Date('2026-09-30T15:59:59Z'))).toBe('2026-09-30')
    expect(dateKey(new Date('2026-09-30T16:00:00Z'))).toBe('2026-10-01')
  })
  it('禅道待处理 Bug 不允许手动完成，禅道普通任务与手动待办支持手动完成', () => {
    const bugTask = { id: 'b1', reference: 'BUG-101', source: 'zentao' as const, title: 'Bug 待办', createdAt: '2026-09-20T01:00:00Z', completedAt: null, zentao: { instance: '', account: '', type: 'bug' as const, id: '101', status: 'active', url: '', priority: 1, project: 'P', deadline: null } }
    const taskItem = { id: 't1', reference: 'TASK-102', source: 'zentao' as const, title: '任务待办', createdAt: '2026-09-20T01:00:00Z', completedAt: null, zentao: { instance: '', account: '', type: 'task' as const, id: '102', status: 'doing', url: '', priority: 1, project: 'P', deadline: null } }
    const manualTask = { id: 'm1', reference: 'TASK-M1', source: 'manual' as const, title: '手动待办', createdAt: '2026-09-20T01:00:00Z', completedAt: null }
    expect(canManualComplete(bugTask)).toBe(false)
    expect(canManualComplete(taskItem)).toBe(true)
    expect(canManualComplete(manualTask)).toBe(true)
    const state = { version: 1 as const, tasks: [bugTask, taskItem, manualTask] }
    expect(completeTask(state, bugTask.id, today)).toBe(state)
    const completedTask = completeTask(state, taskItem.id, today)
    expect(completedTask.tasks.find((t) => t.id === taskItem.id)?.completedAt).not.toBeNull()
  })
  it('五种自动来源无需完成，直接按来源日期进入日志', () => {
    for (const source of ['codex', 'claude', 'workbuddy', 'zcode', 'gemini'] as const) {
      const task = { ...fixture().tasks[0], source, completedAt: null, createdAt: '2026-09-20T01:00:00Z', recordedAt: '2026-09-24T16:10:00Z' }
      expect(requiresManualCompletion(source)).toBe(false)
      expect(recordsForDate({ version: 1, tasks: [task] }, '2026-09-25')).toEqual([task])
      expect(recordsForDate({ version: 1, tasks: [task] }, '2026-09-30')).toEqual([])
      expect(task.completedAt).toBeNull()
      const state = { version: 1 as const, tasks: [task] }
      expect(completeTask(state, task.id, today)).toBe(state)
    }
  })
  it('旧自动记录从证据原始时间归档，手工及禅道只在完成后归档', () => {
    const task = { ...fixture().tasks[0], source: 'codex' as const, completedAt: null, evidence: [{ messageId: 'm', sessionId: 's', source: 'codex' as const, projectPath: '', quote: '', timestamp: '2026-09-24T03:00:00Z' }] }
    expect(recordTimestamp(task)).toBe('2026-09-24T03:00:00Z')
    for (const source of ['manual', 'zentao'] as const) {
      expect(requiresManualCompletion(source)).toBe(true)
      expect(recordTimestamp({ ...task, source })).toBeNull()
      expect(recordTimestamp({ ...task, source, completedAt: '2026-10-01T02:00:00Z' })).toBe('2026-10-01T02:00:00Z')
    }
  })
})
