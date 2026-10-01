import { describe, expect, it } from 'vitest'
import { addTask, completeTask, createDemoState, dateKey, decodeSnapshot, recentWorkdays, recordsForDate } from './workbench'

const today = new Date(2026, 8, 30, 14, 0)

describe('工作台记录', () => {
  it('跨周末与月界仍能生成最近工作日', () => {
    expect(recentWorkdays(new Date(2026, 8, 1))).toEqual(['2026-09-01', '2026-08-31', '2026-08-28', '2026-08-27'])
  })

  it('同一任务只归档一次，原状态保持不变', () => {
    const initial = createDemoState(today)
    const task = initial.tasks.find((item) => !item.completedAt)!
    const completed = completeTask(initial, task.id, today)
    expect(recordsForDate(completed, dateKey(today))).toHaveLength(3)
    expect(initial.tasks.find((item) => item.id === task.id)?.completedAt).toBeNull()
    expect(completeTask(completed, task.id, new Date(2026, 9, 1))).toBe(completed)
    expect(completeTask(completed, '不存在的任务', today)).toBe(completed)
  })

  it('跨日归档进入完成当天，保留历史记录', () => {
    const initial = createDemoState(today)
    const tomorrow = new Date(2026, 9, 1, 0, 1)
    const completed = completeTask(initial, initial.tasks[0].id, tomorrow)
    expect(recordsForDate(completed, '2026-09-30')).toHaveLength(2)
    expect(recordsForDate(completed, '2026-10-01')[0].id).toBe(initial.tasks[0].id)
  })

  it('新增任务修剪空白，拒绝空内容、过长内容与重复标识', () => {
    const initial = createDemoState(today)
    const added = addTask(initial, '  整理接口回归结果  ', 'new-task', today)
    expect(added.tasks[0].title).toBe('整理接口回归结果')
    expect(added.tasks[0].completedAt).toBeNull()
    expect(addTask(initial, '   ', 'blank', today)).toBe(initial)
    expect(addTask(initial, '字'.repeat(301), 'long', today)).toBe(initial)
    expect(addTask(added, '另一项', 'new-task', today)).toBe(added)
  })

  it('缓存往返保持完整，损坏数据不会进入页面', () => {
    const initial = createDemoState(today)
    expect(decodeSnapshot(JSON.stringify(initial))).toEqual(initial)
    expect(decodeSnapshot('{不完整')).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ ...initial, version: 2 }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [{ ...initial.tasks[0], source: '未知工具' }] }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [{ ...initial.tasks[0], completedAt: '非日期' }] }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ version: 1, tasks: [initial.tasks[0], initial.tasks[0]] }))).toBeNull()
  })

  it('归档列表按完成时间排序', () => {
    const initial = createDemoState(today)
    const completed = completeTask(initial, initial.tasks[0].id, today)
    expect(recordsForDate(completed, dateKey(today)).map((task) => task.reference)).toEqual(['BUG-20489', 'SESSION-882', 'TASK-1002'])
  })
})
