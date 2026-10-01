import { describe, expect, it } from 'vitest'
import { dailyReportText } from './dailyReport'

describe('日报复制文本', () => {
  it('包含所选日期和分点正文，不带来源ID或页面操作文案', () => {
    expect(dailyReportText({ day: '2026-10-01', generatedAt: '2026-10-01T03:00:00Z', recordCount: 3, revision: 1, recordVersions: {}, items: [
      { text: '完善测试计划，汇总相关验证进展。', taskIds: ['task-1', 'task-2'] },
      { text: '梳理发布检查流程，仍在补充异常场景。', taskIds: ['task-3'] },
    ] })).toBe('工作日报｜2026年10月1日\n\n1. 完善测试计划，汇总相关验证进展。\n2. 梳理发布检查流程，仍在补充异常场景。')
  })
})
