import { describe, expect, it } from 'vitest'
import { aggregatePeriodData, periodicMarkdownSections } from '../src/domain/periodicReport.js'
import { parsePeriodicReportSummary, periodicReportSummaryInput } from './periodicReportSummary.js'
import type { DailyReport } from '../shared/contracts.js'

const at = '2026-10-12T03:00:00Z'
const reports: DailyReport[] = [
  { day: '2026-10-12', generatedAt: at, revision: 1, recordCount: 1, recordVersions: {}, items: [
    { topic: '在线客服知识库建设', text: '旧概述', subItems: ['完成名片文档入库', '客资文档待整理'], taskIds: ['one'], projectPaths: ['/本机/secret/在线客服'] },
  ] },
  { day: '2026-10-15', generatedAt: at, revision: 1, recordCount: 2, recordVersions: {}, items: [
    { topic: '知识库内容维护', text: '完成客资文档及剩余分类入库', taskIds: ['two'] },
    { topic: '日常事务', text: '提交日报', taskIds: ['three'] },
  ] },
]
const input = () => periodicReportSummaryInput('weekly', aggregatePeriodData('2026-10-12', '2026-10-18', reports, [
  { id: 'p', reference: 'p', source: 'manual', title: '执行机器人接待回归测试', createdAt: at, completedAt: null },
  { id: 'private', reference: 'private', source: 'manual', title: '安排私人购物', createdAt: at, completedAt: null, isPersonal: true },
]))
const summary = () => ({ achievements: [{ topic: '在线客服知识库', outcomes: ['完成名片文档入库', '完成客资文档及剩余分类入库'], sourceIds: ['R1', 'R2'] }],
  omittedSourceIds: ['R3'], inProgress: [{ text: '机器人接待回归测试仍在推进', sourceIds: ['P1'] }], nextPlan: [{ text: '继续执行机器人接待回归并核验会话记录', sourceIds: ['P1'] }] })

describe('周月报跨天语义归纳契约', () => {
  it('只提供周期内非私人摘要和项目名，保留子项，不发送路径或会话证据', () => {
    const data = input()
    expect(data.records).toHaveLength(3)
    expect(data.records[0].text).toBe('完成名片文档入库；客资文档待整理')
    expect(data.records[0].projects).toEqual(['在线客服'])
    expect(JSON.stringify(data)).not.toMatch(/本机|secret|私人购物/)
    expect(data.pending).toHaveLength(1)
  })
  it('跨天多主题合为同一项目，独立成果分为子项，省略例行日报', () => {
    const sections = parsePeriodicReportSummary(JSON.stringify(summary()), input())
    expect(sections[0].items).toHaveLength(1)
    expect(sections[0].items[0]).toBe('【在线客服知识库】\n   - 完成名片文档入库\n   - 完成客资文档及剩余分类入库')
    expect(JSON.stringify(sections)).not.toMatch(/提交日报|待整理/)
    expect(sections[1].items).not.toEqual(sections[2].items)
    const markdown = sections.map((section) => `### ${section.title}\n\n${section.items.map((text, index) => `${index + 1}. ${text}`).join('\n')}`).join('\n\n')
    expect(periodicMarkdownSections(markdown)).toEqual(sections)
  })
  it('拒绝遗漏、重复和伪造素材引用', () => {
    const missing = summary(); missing.achievements[0].sourceIds = ['R1']
    expect(() => parsePeriodicReportSummary(JSON.stringify(missing), input())).toThrow('遗漏')
    const duplicate = summary(); duplicate.omittedSourceIds.push('R1')
    expect(() => parsePeriodicReportSummary(JSON.stringify(duplicate), input())).toThrow('重复')
    const unknown = summary(); unknown.nextPlan[0].sourceIds = ['P99']
    expect(() => parsePeriodicReportSummary(JSON.stringify(unknown), input())).toThrow('未知')
  })
  it('无风险或计划证据时，不编造推进正常或下一期安排', () => {
    const value = summary(); value.inProgress = []; value.nextPlan = []
    const sections = parsePeriodicReportSummary(JSON.stringify(value), input())
    expect(sections[1].items[0]).toContain('未提供明确')
    expect(sections[2].items[0]).toContain('未明确')
  })
  it('月报使用相同归纳契约', () => {
    const sections = parsePeriodicReportSummary(JSON.stringify(summary()), { ...input(), type: 'monthly' })
    expect(sections[0].title).toContain('本月')
    expect(sections[2].title).toContain('下月')
  })
})
