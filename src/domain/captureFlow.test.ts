import { describe, expect, it } from 'vitest'
import { changedCaptureDestinations } from './captureFlow'
import type { Task } from './workbench'

const task: Task = { id: 'plan-one', source: 'manual', reference: 'PLAN-ONE', title: '提交项目复盘', createdAt: '2026-10-17T01:00:00Z',
  completedAt: null, scheduledPlan: { id: 'plan', scheduledAt: '2026-10-17T01:00:00Z' } }
describe('计划待办与采集流光', () => {
  it('首次快照不回放，后续新增计划待办触发芯片到待办流光，重复刷新不再触发', () => {
    expect(changedCaptureDestinations(null, [task])).toEqual([])
    expect(changedCaptureDestinations([], [task])).toEqual(['tasks'])
    expect(changedCaptureDestinations([task], [task])).toEqual([])
    expect(changedCaptureDestinations([], [{ ...task, scheduledPlan: undefined }])).toEqual([])
  })
})
