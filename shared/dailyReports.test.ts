import { describe, expect, it } from 'vitest'
import { isRecordInReport, mergeDailyReports, reportRecordVersion } from './dailyReports.js'
import type { Task } from '../src/domain/workbench.js'
import type { DailyReport } from './contracts.js'

const task: Task = { id: 'task-1', title: '完善工作日报', source: 'codex', reference: 'CX-1', createdAt: '2026-10-01T03:00:00Z', recordedAt: '2026-10-01T03:00:00Z', completedAt: null }
const report: DailyReport = { day: '2026-10-01', generatedAt: task.createdAt, revision: 1, recordCount: 1,
  items: [{ text: '完善工作日报。', taskIds: [task.id] }], recordVersions: { [task.id]: reportRecordVersion(task) } }
describe('日志整理状态', () => {
  it('未整理或简介、状态更新时待补充，证据追加不触发重整', () => {
    expect(isRecordInReport(task, null)).toBe(false)
    expect(isRecordInReport(task, report)).toBe(true)
    expect(isRecordInReport({ ...task, title: '完善工作日报补充功能' }, report)).toBe(false)
    expect(isRecordInReport({ ...task, completedAt: task.createdAt }, report)).toBe(false)
    expect(isRecordInReport({ ...task, evidence: [] }, report)).toBe(true)
  })
  it('后台旧快照不能覆盖刚保存的新日报和整理标记', () => {
    const newer = { ...report, revision: 2, recordCount: 2 }
    expect(mergeDailyReports([newer], [report])).toEqual([newer])
    expect(mergeDailyReports([report], [newer])).toEqual([newer])
  })
})
