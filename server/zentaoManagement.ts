import type {
  DateInput, EffectiveDate, ReleaseDates, ManagementBatch, ManagementStory, ManagementExecution,
  ManagementEntity, ManagementTask, ManagementMetrics, ManagementMember, ZentaoManagementSettings,
} from '../shared/zentaoManagement.js'
import { dateKey } from '../src/domain/workbench.js'

const dayMs = 86_400_000
export const storyRuleIds = ['release', 'dates', 'coverage', 'review', 'changed-cases'] as const
export type RiskCandidate = Pick<ManagementTask, 'key' | 'ruleId' | 'instance' | 'account' | 'projectId' | 'project' |
  'executionId' | 'execution' | 'scopeIds' | 'severity' | 'reason' | 'action' | 'entities' | 'dates'>
export interface ManagementEvaluation {
  risks: RiskCandidate[]; evaluatedKeys: string[]; completeScopeIds: string[]; presentStoryIds: string[]
  metrics: ManagementMetrics[]; members: ManagementMember[]
  datesByStory: Record<string, ReleaseDates>
}
export const riskKey = (rule: string, id: string) => rule + ':' + id
const ended = (status: string) => ['closed', 'done'].includes(status)
const closed = (status: string) => status === 'closed'
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / dayMs)
const nearDate = (value: EffectiveDate, now: Date, warningDays: number) =>
  value.state === 'valid' && daysBetween(value.day!, dateKey(now)) <= warningDays
const validDay = (value: string) => {
  const timestamp = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export function parseManagementDate(input: DateInput, source: EffectiveDate['source'], actual: boolean, now: Date): EffectiveDate {
  const sourceLabel = source === 'story' ? '需求字段' : actual ? '冲刺实际完成时间' : '冲刺计划结束时间'
  const base: EffectiveDate = { state: input.state === 'value' ? 'invalid' : input.state,
    value: null, day: null, timestamp: null, precision: 'day', source, sourceLabel }
  if (input.state !== 'value') return base
  const value = input.value.trim()
  base.value = value
  const day = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validDay(day)) return base
  const onlyDay = value === day
  if (!onlyDay && !/^\d{4}-\d{2}-\d{2}[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/.test(value)) return base
  let normalized = value.replace(' ', 'T')
  if (onlyDay) normalized += actual ? 'T00:00:00+08:00' : 'T23:59:59.999+08:00'
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += '+08:00'
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp) || actual && (onlyDay ? day > dateKey(now) : timestamp > now.getTime())) return base
  return { ...base, state: 'valid', value, day: onlyDay ? day : dateKey(new Date(timestamp)), timestamp, precision: onlyDay ? 'day' : 'time' }
}

export function selectFallbackExecution(executions: ManagementExecution[], now: Date): ManagementExecution | null {
  const valid = executions.filter((execution) => !execution.removed && parseManagementDate(execution.end, 'execution', false, now).state === 'valid')
  valid.sort((a, b) => parseManagementDate(b.end, 'execution', false, now).timestamp! -
    parseManagementDate(a.end, 'execution', false, now).timestamp! || Number(b.id) - Number(a.id))
  return valid[0] ?? null
}

export function resolveReleaseDates(story: ManagementStory, executions: ManagementExecution[], now: Date): ReleaseDates {
  const fallback = selectFallbackExecution(executions, now)
  const unknownEnd = executions.some((entry) => !entry.removed && entry.end.state === 'unavailable')
  const invalidEnd = !fallback && executions.some((entry) => !entry.removed && parseManagementDate(entry.end, 'execution', false, now).state === 'invalid')
  const get = (input: DateInput, actual: boolean): EffectiveDate => {
    const date = input.state === 'empty' ? parseManagementDate(unknownEnd ? { state: 'unavailable', value: '' } : !actual && invalidEnd
      ? { state: 'value', value: '关联冲刺计划结束时间非法' }
      : fallback?.[actual ? 'realEnd' : 'end'] ?? { state: 'empty', value: '' }, 'execution', actual, now)
      : parseManagementDate(input, 'story', actual, now)
    return { ...date, fieldPath: date.source === 'execution' ? actual ? 'realEnd' : 'end'
      : actual ? story.releaseFields?.actual ?? '实际上线时间' : story.releaseFields?.planned ?? '计划上线时间' }
  }
  return { planned: get(story.plannedReleaseAt, false), actual: get(story.actualReleaseAt, true), fallbackExecutionId: unknownEnd ? null : fallback?.id ?? null }
}

export function isLateRelease(dates: ReleaseDates): boolean {
  if (dates.planned.state !== 'valid' || dates.actual.state !== 'valid') return false
  return dates.planned.precision === 'day' || dates.actual.precision === 'day'
    ? dates.actual.day! > dates.planned.day! : dates.actual.timestamp! > dates.planned.timestamp!
}
function fallbackRelationsComplete(batch: ManagementBatch, fallback: ManagementExecution | null, now: Date) {
  if (batch.relationsComplete) return true
  if (!batch.associationGaps?.length) return false
  // 已知结束时间早于候选冲刺的历史缺口不可能改变最晚日期选择。
  return batch.associationGaps.every((id) => {
    const execution = batch.executions.find((entry) => entry.id === id)
    if (!execution) return false
    if (execution.removed) return true
    const end = parseManagementDate(execution.end, 'execution', false, now)
    if (end.state === 'empty') return true
    if (end.state !== 'valid' || !fallback) return false
    const chosen = parseManagementDate(fallback.end, 'execution', false, now)
    return end.timestamp! < chosen.timestamp! || end.timestamp === chosen.timestamp && Number(execution.id) <= Number(fallback.id)
  })
}

export function evaluateManagement(batch: ManagementBatch, settings: ZentaoManagementSettings, now = new Date(batch.collectedAt)): ManagementEvaluation {
  const risks = new Map<string, RiskCandidate>(), evaluated = new Set<string>(), datesByStory = new Map<string, ReleaseDates>()
  const stories = new Map<string, ManagementStory>()
  const monitoredRelationsComplete = batch.relationsComplete || !!batch.associationGaps?.length &&
    batch.associationGaps.every((id) => !batch.scopes.some((scope) => scope.execution.id === id && !scope.execution.removed))
  for (const scope of batch.scopes) for (const story of scope.stories) {
    const previous = stories.get(story.id)
    if (!previous || Number(story.version) >= Number(previous.version)) stories.set(story.id, story)
  }
  const completeScopeIds = batch.scopes.filter((scope) => Object.values(scope.readable).every(Boolean) && batch.relationsComplete)
    .map((scope) => scope.execution.id)
  const add = (ruleId: string, id: string, execution: ManagementExecution, entities: ManagementEntity[],
    severity: RiskCandidate['severity'], action: string, reason: string, dates?: ReleaseDates, scopeIds = [execution.id]) => {
    const key = riskKey(ruleId, id)
    risks.set(key, { key, ruleId, instance: batch.instance, account: batch.account, projectId: execution.projectId,
      project: execution.project, executionId: execution.id, execution: execution.title, scopeIds,
      severity, action: action.slice(0, 300), reason, entities, dates })
  }
  for (const story of stories.values()) {
    const linked = batch.executions.filter((execution) => (batch.associations[story.id] ?? story.executionIds).includes(execution.id))
    const fallback = selectFallbackExecution(linked, now)
    const scope = batch.scopes.find((entry) => entry.execution.id === fallback?.id) ??
      batch.scopes.find((entry) => entry.stories.some((entry) => entry.id === story.id))
    if (!scope) continue
    const execution = fallback ?? scope.execution
    const scopeIds = batch.scopes.filter((entry) => entry.stories.some((entry) => entry.id === story.id)).map((entry) => entry.execution.id)
    if (story.removed || story.parent || execution.removed) {
      for (const rule of storyRuleIds) evaluated.add(riskKey(rule, story.id))
      continue
    }
    const dates = resolveReleaseDates(story, linked, now)
    const needsFallback = story.plannedReleaseAt.state === 'empty' || story.actualReleaseAt.state === 'empty'
    const relatedComplete = fallbackRelationsComplete(batch, fallback, now)
    if (needsFallback && !relatedComplete) {
      for (const key of ['planned', 'actual'] as const) if (dates[key].source === 'execution') dates[key] = {
        ...dates[key], state: 'unavailable', value: null, day: null, timestamp: null,
      }
      dates.fallbackExecutionId = null
    }
    datesByStory.set(story.id, dates)
    const datesReadable = (!needsFallback || relatedComplete) && dates.planned.state !== 'unavailable' && dates.actual.state !== 'unavailable'
    if (dates.actual.state === 'valid') evaluated.add(riskKey('release', story.id))
    const invalid = dates.planned.state === 'invalid' || dates.actual.state === 'invalid'
    if (datesReadable || invalid) {
      evaluated.add(riskKey('dates', story.id))
      if (invalid || dates.planned.state === 'empty') add('dates', story.id, execution, [story], 'gray',
        (invalid ? '核对' : '补充') + '「' + story.title + '」的上线日期依据',
        invalid ? '日期格式非法或实际上线时间在未来，请核对需求字段及冲刺日期。' : '需求计划上线时间及关联冲刺结束时间均未填写。', dates, scopeIds)
      if (!invalid && datesReadable) {
        evaluated.add(riskKey('release', story.id))
        if (!ended(story.status) && dates.actual.state === 'empty' && dates.planned.state === 'valid') {
          const overdue = dates.planned.timestamp! < now.getTime()
          const near = nearDate(dates.planned, now, settings.warningDays)
          if (near) add('release', story.id, execution, [story], overdue ? 'red' : 'yellow',
            '跟进「' + story.title + '」的' + (overdue ? '上线延期' : '上线准备'),
            '计划节点为 ' + dates.planned.value + '（' + dates.planned.sourceLabel + '），尚无实际上线节点。', dates, scopeIds)
        }
      }
    }
    const relatedScopes = batch.scopes.filter((entry) => scopeIds.includes(entry.execution.id))
    const casesReadable = relatedScopes.every((entry) => entry.readable.cases) && monitoredRelationsComplete
    if (casesReadable) {
      const cases = [...new Map(relatedScopes.flatMap((entry) => entry.cases)
        .filter((entry) => entry.storyId === story.id && !entry.removed).map((entry) => [entry.id, entry])).values()]
      for (const rule of ['coverage', 'review', 'changed-cases']) evaluated.add(riskKey(rule, story.id))
      const waiting = cases.filter((entry) => entry.status === 'wait' && entry.waitSince &&
        now.getTime() - Date.parse(entry.waitSince) >= settings.reviewDays * dayMs)
      if (waiting.length) add('review', story.id, execution, waiting, 'yellow', '推进「' + story.title + '」的用例评审',
        String(waiting.length) + ' 条用例持续待评审至少 ' + settings.reviewDays + ' 天，计时依据为提交时间或首次观察时间。', undefined, scopeIds)
      const changed = cases.filter((entry) => entry.needConfirm)
      if (changed.length) add('changed-cases', story.id, execution, changed, 'yellow', '复核「' + story.title + '」变更后的用例',
        String(changed.length) + ' 条关联用例被禅道标记为需求变更待确认。', undefined, scopeIds)
    }
  }
  const metrics: ManagementMetrics[] = [], members: ManagementMember[] = []
  for (const scope of batch.scopes) {
    const execution = scope.execution
    const activeStories = [...new Map(scope.stories.filter((entry) => !entry.removed && !entry.parent).map((entry) => [entry.id, entry])).values()]
    const cases = [...new Map(scope.cases.filter((entry) => !entry.removed).map((entry) => [entry.id, entry])).values()]
    const openTesttasks = [...new Map(scope.testtasks.filter((entry) => !entry.removed && !ended(entry.status)).map((entry) => [entry.id, entry])).values()]
    const severe = [...new Map(scope.bugs.filter((entry) => !entry.removed && ['active', 'resolved'].includes(entry.status) && entry.severity !== null && entry.severity <= 2).map((entry) => [entry.id, entry])).values()]
    const end = parseManagementDate(execution.end, 'execution', false, now)
    if (execution.removed) {
      for (const rule of ['sprint', 'close-stories', 'close-testtasks', 'severe-bugs']) evaluated.add(riskKey(rule, execution.id))
      continue
    }
    if (ended(execution.status)) evaluated.add(riskKey('sprint', execution.id))
    if (end.state === 'valid') {
      evaluated.add(riskKey('sprint', execution.id))
      if (!ended(execution.status) && end.timestamp! < now.getTime()) add('sprint', execution.id, execution, [execution], 'red',
        '协调「' + execution.title + '」延期收尾', '冲刺计划结束时间为 ' + end.value + '，当前仍未结束。')
    }
    const closeReadable = scope.readable.stories && (closed(execution.status) || monitoredRelationsComplete &&
      activeStories.every((entry) => datesByStory.has(entry.id) && !['unavailable', 'invalid'].includes(datesByStory.get(entry.id)!.actual.state)))
    if (closeReadable) {
      evaluated.add(riskKey('close-stories', execution.id))
      const residual = activeStories.filter((entry) => !closed(entry.status) &&
        (closed(execution.status) || datesByStory.get(entry.id)?.actual.state === 'valid'))
      if (residual.length) add('close-stories', execution.id, execution, residual, 'red', '协调「' + execution.title + '」的需求关闭',
        String(residual.length) + ' 项需求已有上线节点或所属冲刺已关闭，但需求尚未关闭。')
    }
    if (scope.readable.testtasks) {
      evaluated.add(riskKey('close-testtasks', execution.id))
      if (closed(execution.status) && openTesttasks.length) add('close-testtasks', execution.id, execution, openTesttasks, 'red',
        '协调关闭「' + execution.title + '」的测试单', '冲刺已关闭，仍有 ' + openTesttasks.length + ' 张测试单未关闭。')
    }
    if (scope.readable.cases && scope.readable.stories && monitoredRelationsComplete) {
      const orphanCases = cases.filter((entry) => !entry.storyId || !stories.has(entry.storyId))
      for (const rule of ['review', 'changed-cases']) evaluated.add(riskKey(rule, 'execution:' + execution.id))
      const waiting = orphanCases.filter((entry) => entry.status === 'wait' && entry.waitSince &&
        now.getTime() - Date.parse(entry.waitSince) >= settings.reviewDays * dayMs)
      if (waiting.length) add('review', 'execution:' + execution.id, execution, waiting, 'yellow', '推进「' + execution.title + '」的未关联需求用例评审',
        String(waiting.length) + ' 条冲刺关联用例持续待评审，请核对需求关联并推进评审。')
      const changed = orphanCases.filter((entry) => entry.needConfirm)
      if (changed.length) add('changed-cases', 'execution:' + execution.id, execution, changed, 'yellow', '确认「' + execution.title + '」的用例需求关联',
        String(changed.length) + ' 条用例标记为需求变更待确认，但未找到有效需求关联。')
    }
    const storyNear = activeStories.some((entry) => {
      const date = datesByStory.get(entry.id)?.planned
      return !!date && nearDate(date, now, settings.warningDays)
    })
    if (scope.readable.bugs && (!severe.length || end.state === 'valid' || monitoredRelationsComplete && storyNear)) {
      evaluated.add(riskKey('severe-bugs', execution.id))
      if (severe.length && (storyNear || nearDate(end, now, settings.warningDays))) add('severe-bugs', execution.id,
        execution, severe, 'red', '推进「' + execution.title + '」的严重缺陷收敛', '临期仍有 ' + severe.length + ' 个严重程度1／2的活跃或待验证缺陷。')
    }
    const scopeRisks = [...risks.values()].filter((entry) => entry.scopeIds.includes(execution.id))
    const missingDate = activeStories.some((entry) => !datesByStory.has(entry.id) ||
      datesByStory.get(entry.id)!.planned.state === 'unavailable' || datesByStory.get(entry.id)!.actual.state === 'unavailable')
    const issues = [...scope.issues, ...(!monitoredRelationsComplete ? ['监控冲刺的需求关联关系未完整读取'] : []),
      ...(missingDate ? ['需求自定义上线字段未完整读取，请核对字段映射'] : [])]
    const incomplete = !Object.values(scope.readable).every(Boolean) || !monitoredRelationsComplete || missingDate
    const released = activeStories.filter((entry) => datesByStory.get(entry.id)?.actual.state === 'valid')
    const datedReleased = released.filter((entry) => datesByStory.get(entry.id)?.planned.state === 'valid')
    metrics.push({ executionId: execution.id, execution: execution.title, projectId: execution.projectId, project: execution.project,
      collectedAt: scope.collectedAt, issues, incomplete,
      unknownMetrics: [...(!scope.readable.stories ? ['stories' as const] : []), ...(missingDate || !monitoredRelationsComplete ? ['dates' as const] : []),
        ...(!scope.readable.cases ? ['cases' as const] : []), ...(!scope.readable.bugs ? ['bugs' as const] : []), ...(!scope.readable.testtasks ? ['testtasks' as const] : [])],
      health: scopeRisks.some((entry) => entry.severity === 'red') ? 'red' : incomplete || scopeRisks.some((entry) => entry.severity === 'gray') ? 'gray' :
        scopeRisks.length ? 'yellow' : 'green',
      storyCount: activeStories.length, released: released.length,
      inferredReleased: released.filter((entry) => datesByStory.get(entry.id)!.actual.source === 'execution').length,
      overdue: scopeRisks.filter((entry) => entry.ruleId === 'release' && entry.severity === 'red').length,
      closed: activeStories.filter((entry) => closed(entry.status)).length,
      covered: activeStories.filter((entry) => cases.some((testcase) => testcase.storyId === entry.id)).length,
      reviewPending: cases.filter((entry) => entry.status === 'wait').length, severeBugs: severe.length,
      openTesttasks: openTesttasks.length, datedReleased: datedReleased.length,
      onTimeReleased: datedReleased.filter((entry) => !isLateRelease(datesByStory.get(entry.id)!)).length })
    const begin = parseManagementDate(execution.begin, 'execution', false, now)
    const realEnd = parseManagementDate(execution.realEnd, 'execution', true, now)
    const sprintStart = begin.precision === 'time' ? begin.timestamp : Date.parse(begin.day! + 'T00:00:00+08:00')
    const sprintFinish = realEnd.state === 'valid' ? realEnd.timestamp! + (realEnd.precision === 'day' ? dayMs - 1 : 0)
      : closed(execution.status) && execution.closedAt ? Math.min(now.getTime(), Date.parse(execution.closedAt)) : now.getTime()
    for (const account of new Set(cases.map((entry) => entry.createdBy || '未记录创建人'))) {
      const own = cases.filter((entry) => (entry.createdBy || '未记录创建人') === account)
      const recent = (date: string | null) => !!date && Date.parse(date) <= now.getTime() && Date.parse(date) >= now.getTime() - 7 * dayMs
      members.push({ account, executionId: execution.id, execution: execution.title, projectId: execution.projectId,
        caseCount: own.length, sprintCreated: own.filter((entry) => entry.createdAt && begin.state === 'valid' &&
          Date.parse(entry.createdAt) >= sprintStart! && Date.parse(entry.createdAt) <= sprintFinish && Date.parse(entry.createdAt) <= now.getTime()).length,
        recentCreated: own.filter((entry) => recent(entry.createdAt)).length,
        recentEdited: own.filter((entry) => recent(entry.editedAt)).length, reviewPending: own.filter((entry) => entry.status === 'wait').length })
    }
  }
  return { risks: [...risks.values()], evaluatedKeys: [...evaluated], completeScopeIds, presentStoryIds: [...stories.keys()], metrics, members,
    datesByStory: Object.fromEntries(datesByStory) }
}
