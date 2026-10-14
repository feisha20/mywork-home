import { describe, expect, it } from 'vitest'
import { dailyReportItemDisplay } from '../../shared/dailyReports'
import { dailyReportText } from './dailyReport'

describe('日报复制文本', () => {
  it('项目多项成果保留子项缩进，单项工作保持原有格式', () => {
    expect(dailyReportText({ day: '2026-10-14', generatedAt: '2026-10-14T03:00:00Z', recordCount: 3,
      revision: 1, recordVersions: {}, items: [
        { topic: '个人工作台', text: '放宽摘要限制；支持重新整理', subItems: ['放宽摘要限制。', '支持重新整理，待验证。'], taskIds: ['a', 'b'] },
        { text: '完成需求归档。', taskIds: ['c'] },
      ] })).toBe('工作日报｜2026年10月14日\n\n1. 个人工作台\n   - 放宽摘要限制。\n   - 支持重新整理，待验证。\n2. 完成需求归档。')
  })
  it('旧摘要仅按明确分号分点，不将普通句子强行拆开', () => {
    const text = '个人工作台日报功能优化：放宽摘要限制；支持重新整理。'
    expect(dailyReportItemDisplay({ text, taskIds: ['a'] })).toEqual({ heading: '个人工作台日报功能优化', subItems: ['放宽摘要限制', '支持重新整理。'] })
    expect(dailyReportItemDisplay({ text: '完成摘要优化。继续核对效果。', topic: '个人工作台', taskIds: ['a'] })).toBeNull()
    expect(dailyReportItemDisplay({ text: '独立工作甲；独立工作乙', taskIds: ['a'] })).toBeNull()
  })

  it('包含所选日期和分点正文，不带来源ID或页面操作文案', () => {
    expect(dailyReportText({ day: '2026-10-01', generatedAt: '2026-10-01T03:00:00Z', recordCount: 3, revision: 1, recordVersions: {}, items: [
      { text: '完善测试计划，汇总相关验证进展。', taskIds: ['task-1', 'task-2'] },
      { text: '梳理发布检查流程，仍在补充异常场景。', taskIds: ['task-3'] },
    ] })).toBe('工作日报｜2026年10月1日\n\n1. 完善测试计划，汇总相关验证进展。\n2. 梳理发布检查流程，仍在补充异常场景。')
  })
})
