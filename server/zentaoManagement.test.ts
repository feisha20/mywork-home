import { describe, expect, it } from 'vitest'
import { defaultZentaoManagement } from '../shared/zentaoManagement.js'
import { evaluateManagement, isLateRelease, parseManagementDate, resolveReleaseDates, selectFallbackExecution } from './zentaoManagement.js'
import { dateInput, mappedReleaseDate } from './zentaoManagementReader.js'
import { emptyDate, managementBatch, managementCase, valueDate } from './zentaoManagement.fixtures.js'

const config = defaultZentaoManagement
const now = new Date('2026-10-06T04:00:00Z')
const rules = (batch: ReturnType<typeof managementBatch>) => evaluateManagement(batch, config).risks

describe('禅道上线日期口径', () => {
  it('空值、空白、零日期和未返回字段分别归一', () => {
    for (const value of [null, undefined, '', '  ', '0000-00-00', '0000-00-00 00:00:00']) expect(dateInput(value).state).toBe('empty')
    expect(dateInput(undefined, false).state).toBe('unavailable')
    expect(dateInput('不是日期').state).toBe('value')
    expect(mappedReleaseDate({ custom: { plan: null } }, 'custom.plan', '计划上线时间').state).toBe('empty')
    expect(mappedReleaseDate({ custom: {} }, 'custom.plan', '计划上线时间').state).toBe('unavailable')
    expect(mappedReleaseDate({}, '__proto__.x', '计划上线时间').state).toBe('unavailable')
    expect(mappedReleaseDate({ customFields: [{ label: '实际上线时间', value: '2026-10-01' }] }, '', '实际上线时间')).toEqual(valueDate('2026-10-01'))
  })
  it('字段独立优先与兜底，并记录来源', () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-10-10') }, { realEnd: valueDate('2026-10-05') })
    const story = batch.scopes[0].stories[0]
    let dates = resolveReleaseDates(story, batch.executions, now)
    expect(dates.planned).toMatchObject({ value: '2026-10-10', source: 'story' })
    expect(dates.actual).toMatchObject({ value: '2026-10-05', source: 'execution' })
    story.plannedReleaseAt = { ...emptyDate }; story.actualReleaseAt = valueDate('2026-10-04')
    dates = resolveReleaseDates(story, batch.executions, now)
    expect(dates.planned).toMatchObject({ value: '2026-10-07', source: 'execution' })
    expect(dates.actual).toMatchObject({ value: '2026-10-04', source: 'story' })
  })
  it('多个关联冲刺选计划最晚，两个兜底都取它；并列取较大编号', () => {
    const batch = managementBatch()
    const earlier = { ...batch.executions[0], id: '9', end: valueDate('2026-10-04'), realEnd: valueDate('2026-10-04') }
    const latest = { ...batch.executions[0], id: '11' }
    expect(selectFallbackExecution([earlier, batch.executions[0], latest], now)?.id).toBe('11')
    const dates = resolveReleaseDates(batch.scopes[0].stories[0], [earlier, latest], now)
    expect(dates.fallbackExecutionId).toBe('11')
    expect(dates.actual.state).toBe('empty')
    expect(selectFallbackExecution([{ ...latest, removed: true }, earlier], now)?.id).toBe('9')
  })
  it.each(['2026-02-30', '2026-10-06 25:00:00', '错误日期'])('非法值不当作空值兜底：%s', (value) => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate(value) })
    const dates = resolveReleaseDates(batch.scopes[0].stories[0], batch.executions, now)
    expect(dates.planned.state).toBe('invalid')
    expect(rules(batch).map((risk) => risk.ruleId)).toEqual(['dates'])
  })
  it('未来实际时间核对；未返回字段保留判断等待更新', () => {
    expect(parseManagementDate(valueDate('2026-10-07'), 'story', true, now).state).toBe('invalid')
    expect(parseManagementDate(valueDate('2026-10-06 13:00:00'), 'story', true, now).state).toBe('invalid')
    const batch = managementBatch(undefined, { actualReleaseAt: { state: 'unavailable', value: '' } })
    const evaluation = evaluateManagement(batch, config)
    expect(evaluation.evaluatedKeys).not.toContain('release:101')
    expect(evaluation.metrics[0]).toMatchObject({ incomplete: true, health: 'gray' })
  })
  it('无计划及兜底日期产生补充事项', () => {
    const batch = managementBatch(undefined, {}, { end: { ...emptyDate } })
    expect(rules(batch)).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'dates', severity: 'gray' })]))
  })
  it('关联冲刺日期非法提示核对；未知结束时间不能选其他冲刺替代', () => {
    const batch = managementBatch(undefined, {}, { end: valueDate('非法日期') })
    expect(rules(batch).find((risk) => risk.ruleId === 'dates')?.action).toContain('核对')
    const unknown = { ...batch.executions[0], id: '11', end: { state: 'unavailable' as const, value: '' } }
    batch.executions[0].end = valueDate('2026-10-07')
    const dates = resolveReleaseDates(batch.scopes[0].stories[0], [...batch.executions, unknown], now)
    expect(dates).toMatchObject({ planned: { state: 'unavailable' }, actual: { state: 'unavailable' }, fallbackExecutionId: null })
  })
  it.each([
    ['2026-10-04T16:00:00Z', '2026-10-09', null],
    ['2026-10-04T16:00:00Z', '2026-10-08', 'yellow'],
    ['2026-10-06T15:59:59Z', '2026-10-06', 'yellow'],
    ['2026-10-06T16:00:00Z', '2026-10-06', 'red'],
    ['2026-10-06T04:00:00Z', '2026-10-06 11:59:59', 'red'],
  ])('北京时间临期与截止边界 %s / %s', (at, plan, severity) => {
    const batch = managementBatch(at, { plannedReleaseAt: valueDate(plan) }, { end: valueDate('2026-11-01') })
    expect(rules(batch).find((risk) => risk.ruleId === 'release')?.severity ?? null).toBe(severity)
  })
  it('仅日期按日比较，双方都有时间时按具体时间；上线后只留下收尾', () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-10-05'), actualReleaseAt: valueDate('2026-10-05 23:00:00') })
    expect(isLateRelease(resolveReleaseDates(batch.scopes[0].stories[0], batch.executions, now))).toBe(false)
    batch.scopes[0].stories[0].plannedReleaseAt = valueDate('2026-10-05 22:00:00')
    const evaluation = evaluateManagement(batch, config)
    expect(isLateRelease(evaluation.datesByStory['101'])).toBe(true)
    expect(evaluation.risks.some((risk) => risk.ruleId === 'release')).toBe(false)
    expect(evaluation.risks.find((risk) => risk.ruleId === 'close-stories')?.severity).toBe('red')
    expect(evaluation.metrics[0]).toMatchObject({ released: 1, datedReleased: 1, onTimeReleased: 0 })
  })
})
describe('测试经理规则与统计', () => {
  it('历史关联缺口不可能改变最晚兜底时继续判断；可能改变时保留未知', () => {
    const batch = managementBatch()
    batch.relationsComplete = false; batch.associationGaps = ['2']
    const historical = { ...batch.executions[0], id: '2', status: 'closed', end: valueDate('2024-01-01') }
    batch.executions.push(historical)
    let evaluation = evaluateManagement(batch, config)
    expect(evaluation.risks.some((risk) => risk.ruleId === 'release')).toBe(true)
    expect(evaluation.metrics[0].incomplete).toBe(false)
    historical.end = valueDate('2026-10-12')
    evaluation = evaluateManagement(batch, config)
    expect(evaluation.risks.some((risk) => risk.ruleId === 'release')).toBe(false)
    expect(evaluation.metrics[0].incomplete).toBe(true)
    expect(evaluation.evaluatedKeys).not.toContain('release:101')
  })
  it('取得可靠实际字段后，即使计划字段待更新仍能确认上线风险已解除', () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: { state: 'unavailable', value: '' }, actualReleaseAt: valueDate('2026-10-05') })
    const evaluation = evaluateManagement(batch, config)
    expect(evaluation.evaluatedKeys).toContain('release:101')
    expect(evaluation.risks.some((risk) => risk.ruleId === 'release')).toBe(false)
    expect(evaluation.risks.some((risk) => risk.ruleId === 'close-stories')).toBe(true)
  })
  it('已确认的非法实际字段仍提示核对，不被另一字段未返回掩盖', () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: { state: 'unavailable', value: '' }, actualReleaseAt: valueDate('2026-10-07') })
    expect(rules(batch).some((risk) => risk.ruleId === 'dates')).toBe(true)
  })
  it('同一需求多个冲刺只生成一个上线风险，范围包含全部关联冲刺', () => {
    const batch = managementBatch()
    const scope = structuredClone(batch.scopes[0]); scope.execution.id = '11'
    batch.scopes.push(scope); batch.executions.push(scope.execution); batch.associations['101'].push('11')
    const risks = rules(batch).filter((risk) => risk.ruleId === 'release')
    expect(risks).toHaveLength(1)
    expect(risks[0]).toMatchObject({ executionId: '11', scopeIds: ['10', '11'] })
  })
  it('用例覆盖缺口不再生成待办，开始满3天或临期仍只保留覆盖统计', () => {
    const batch = managementBatch(undefined, { plannedReleaseAt: valueDate('2026-11-01') }, { begin: valueDate('2026-10-04') })
    batch.scopes[0].cases = []
    expect(rules(batch).some((risk) => risk.ruleId === 'coverage')).toBe(false)
    batch.collectedAt = '2026-10-07T00:00:00Z'
    expect(rules(batch).some((risk) => risk.ruleId === 'coverage')).toBe(false)
    batch.scopes[0].execution.begin = valueDate('2026-10-07'); batch.scopes[0].stories[0].plannedReleaseAt = valueDate('2026-10-08')
    expect(rules(batch).some((risk) => risk.ruleId === 'coverage')).toBe(false)
    batch.scopes[0].stories[0].status = 'draft'
    expect(rules(batch).some((risk) => risk.ruleId === 'coverage')).toBe(false)
  })
  it('待评审计时、需求变更与临期严重缺陷', () => {
    const batch = managementBatch()
    batch.scopes[0].cases = [managementCase({ status: 'wait', waitSince: '2026-10-03T04:00:00Z', needConfirm: true })]
    batch.scopes[0].bugs = [{ type: 'bug', id: '301', title: '登录阻塞', owner: 'dev', url: '', status: 'resolved', removed: false, severity: 2, storyId: '101' }]
    expect(rules(batch).map((risk) => risk.ruleId)).toEqual(expect.arrayContaining(['release', 'review', 'changed-cases', 'severe-bugs']))
    batch.scopes[0].cases[0].waitSince = '2026-10-03T04:00:01Z'
    expect(rules(batch).some((risk) => risk.ruleId === 'review')).toBe(false)
  })
  it('关闭冲刺的需求与测试单汇总，推定上线数量独立展示', () => {
    const batch = managementBatch(undefined, {}, { status: 'closed', realEnd: valueDate('2026-10-05') })
    batch.scopes[0].testtasks = [{ type: 'testtask', id: '401', title: '回归测试单', owner: 'qa', url: '', status: 'doing', removed: false }]
    const evaluation = evaluateManagement(batch, config)
    expect(evaluation.risks.map((risk) => risk.ruleId)).toEqual(['close-stories', 'close-testtasks'])
    // 禅道测试单的 done 表示已关闭，兼容 closed。
    for (const status of ['done', 'closed']) {
      batch.scopes[0].testtasks[0].status = status
      const cleared = evaluateManagement(batch, config)
      expect(cleared.risks.map((risk) => risk.ruleId)).not.toContain('close-testtasks')
      expect(cleared.metrics[0].openTesttasks).toBe(0)
    }
    expect(evaluation.metrics[0]).toMatchObject({ released: 1, inferredReleased: 1 })
  })
  it('父需求和废弃对象排除，用例及成员统计去重', () => {
    const batch = managementBatch(undefined, { status: 'closed', actualReleaseAt: valueDate('2026-10-05') }, { end: valueDate('2026-10-12') })
    batch.scopes[0].stories.push({ ...batch.scopes[0].stories[0], id: '100', parent: true }, { ...batch.scopes[0].stories[0], id: '102', removed: true })
    batch.scopes[0].cases.push(managementCase(), managementCase({ id: '202', removed: true }))
    const evaluation = evaluateManagement(batch, config)
    expect(evaluation.metrics[0]).toMatchObject({ storyCount: 1, covered: 1, health: 'green' })
    expect(evaluation.members[0]).toMatchObject({ account: 'qa1', caseCount: 1, sprintCreated: 1, recentCreated: 1, recentEdited: 1 })
    expect(evaluation.members[0]).not.toHaveProperty('completionRate')
  })
  it('成员关联数包含未关联需求的用例，冲刺结束后新增不算冲刺内新增', () => {
    const batch = managementBatch(undefined, { status: 'closed', actualReleaseAt: valueDate('2026-10-03') },
      { status: 'closed', realEnd: valueDate('2026-10-03'), end: valueDate('2026-10-03') })
    batch.scopes[0].cases.push(managementCase({ id: '202', storyId: '', status: 'wait', waitSince: '2026-10-01T04:00:00Z', createdAt: '2026-10-04T01:00:00Z' }))
    const evaluation = evaluateManagement(batch, config)
    expect(evaluation.members[0]).toMatchObject({ caseCount: 2, sprintCreated: 1, reviewPending: 1 })
    expect(evaluation.risks.some((risk) => risk.key === 'review:execution:10')).toBe(true)
  })
  it('权限或缺页不确认风险解除；独立可读数据继续判断', () => {
    const batch = managementBatch(undefined, {}, { status: 'closed' })
    batch.scopes[0].readable.cases = false
    const evaluation = evaluateManagement(batch, config)
    expect(evaluation.evaluatedKeys).not.toContain('coverage:101')
    expect(evaluation.risks.some((risk) => risk.ruleId === 'close-stories')).toBe(true)
    expect(evaluation.metrics[0].incomplete).toBe(true)
  })
})
