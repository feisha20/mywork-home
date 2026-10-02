import { describe, expect, it } from 'vitest'
import {
  aggregatePeriodData,
  getMonthBounds,
  getWeekBounds,
  listRecentMonths,
  listRecentWeeks,
  synthesizePeriodicReport,
} from './periodicReport'
import type { DailyReport } from '../../shared/contracts'
import type { Task } from './workbench'

describe('periodicReport domain', () => {
  it('correctly calculates week bounds for a given date', () => {
    // 2026-10-02 是周五，该周应该从 2026-09-28 (周一) 到 2026-10-04 (周日)
    const date = new Date('2026-10-02T12:00:00+08:00')
    const bounds = getWeekBounds(date)
    expect(bounds.startDate).toBe('2026-09-28')
    expect(bounds.endDate).toBe('2026-10-04')
    expect(bounds.weekKey).toContain('W')
    expect(bounds.label).toContain('09.28')
    expect(bounds.label).toContain('10.04')
  })

  it('correctly calculates month bounds for a given date', () => {
    // 2026-10-02 属于 2026-10，从 2026-10-01 到 2026-10-31
    const date = new Date('2026-10-02T12:00:00+08:00')
    const bounds = getMonthBounds(date)
    expect(bounds.startDate).toBe('2026-10-01')
    expect(bounds.endDate).toBe('2026-10-31')
    expect(bounds.monthKey).toBe('2026-10')
    expect(bounds.label).toBe('2026年10月')
  })

  it('generates recent weeks and months lists', () => {
    const date = new Date('2026-10-02T12:00:00+08:00')
    const weeks = listRecentWeeks(date, 4)
    expect(weeks).toHaveLength(4)
    expect(weeks[0].isCurrent).toBe(true)
    expect(weeks[1].isCurrent).toBe(false)

    const months = listRecentMonths(date, 3)
    expect(months).toHaveLength(3)
    expect(months[0].monthKey).toBe('2026-10')
    expect(months[0].isCurrent).toBe(true)
    expect(months[1].monthKey).toBe('2026-09')
  })

  it('aggregates daily reports and tasks within a period', () => {
    const reports: DailyReport[] = [
      {
        day: '2026-09-29',
        generatedAt: '2026-09-29T18:00:00Z',
        recordCount: 2,
        revision: 1,
        recordVersions: {},
        items: [{ text: '推进个人工作台建设，完成基础框架搭建。', taskIds: ['t1'], topic: '工作台建设' }],
      },
      {
        day: '2026-10-02',
        generatedAt: '2026-10-02T18:00:00Z',
        recordCount: 3,
        revision: 1,
        recordVersions: {},
        items: [{ text: '优化日志与日报生成交互。', taskIds: ['t2'], topic: '工作台建设' }],
      },
      {
        day: '2026-09-20', // 不在此周
        generatedAt: '2026-09-20T18:00:00Z',
        recordCount: 1,
        revision: 1,
        recordVersions: {},
        items: [{ text: '其他工作', taskIds: ['t0'] }],
      },
    ]

    const tasks: Task[] = [
      {
        id: 't1',
        reference: 'ref-1',
        source: 'manual',
        title: '基础框架搭建',
        createdAt: '2026-09-29T10:00:00Z',
        completedAt: '2026-09-29T17:00:00Z',
        projectPath: '/projects/mywork-home',
      },
      {
        id: 't2',
        reference: 'ref-2',
        source: 'codex',
        title: '优化日报交互',
        createdAt: '2026-10-02T10:00:00Z',
        completedAt: '2026-10-02T17:00:00Z',
        projectPath: '/projects/mywork-home',
      },
      {
        id: 't3',
        reference: 'ref-3',
        source: 'manual',
        title: '待推进的下周任务',
        createdAt: '2026-10-02T11:00:00Z',
        completedAt: null,
      },
    ]

    const aggregated = aggregatePeriodData('2026-09-28', '2026-10-04', reports, tasks)
    expect(aggregated.matchedReports).toHaveLength(2)
    expect(aggregated.completedTasks).toHaveLength(2)
    expect(aggregated.pendingTasks).toHaveLength(1)
    expect(aggregated.stats.reportedDays).toBe(2)
    expect(aggregated.stats.projectCount).toBe(1)
  })

  it('synthesizes periodic report into structured sections and markdown', () => {
    const bounds = {
      label: '2026年第40周 (09.28 - 10.04)',
      startDate: '2026-09-28',
      endDate: '2026-10-04',
      key: '2026-W40',
    }
    const reports: DailyReport[] = [
      {
        day: '2026-09-29',
        generatedAt: '2026-09-29T18:00:00Z',
        recordCount: 1,
        revision: 1,
        recordVersions: {},
        items: [{ text: '完成工作台待办与采集流开发。', taskIds: ['t1'], topic: '工作台' }],
      },
    ]
    const tasks: Task[] = [
      {
        id: 't-pending',
        reference: 'ref-p',
        source: 'manual',
        title: '周报与月报导出模版设计',
        createdAt: '2026-10-01T10:00:00Z',
        completedAt: null,
      },
    ]

    const synthesized = synthesizePeriodicReport('weekly', bounds, reports, tasks)
    expect(synthesized.title).toContain('工作周报')
    expect(synthesized.sections.length).toBeGreaterThan(0)
    expect(synthesized.markdown).toContain('# 2026年第40周 (09.28 - 10.04)工作周报')
    expect(synthesized.markdown).toContain('完成工作台待办与采集流开发')
  })

  it('synthesizes monthly report and handles empty state gracefully', () => {
    const bounds = {
      label: '2026年10月',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      key: '2026-10',
    }

    const emptyReport = synthesizePeriodicReport('monthly', bounds, [], [])
    expect(emptyReport.title).toBe('2026年10月工作月报')
    expect(emptyReport.type).toBe('monthly')
    expect(emptyReport.markdown).toContain('# 2026年10月工作月报')
    expect(emptyReport.markdown).toContain('暂无已归档的工作记录')
  })
})
