import { emptyCollectionCache, type ManagementReadOptions, type CollectionDiagnostics } from './zentaoCollectionCache.js'
import type { DateInput, ManagementBatch, ManagementExecution, ManagementStory, ManagementScope, ZentaoManagementSettings } from '../shared/zentaoManagement.js'
import { zentaoIdentity, type ZentaoConnection } from '../shared/settings.js'
import { zentaoTimestamp, ZentaoError } from './zentao.js'

type Row = Record<string, unknown>
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const idOf = (value: unknown) => (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : ''
const account = (value: unknown) => typeof value === 'string' ? value : object(value) && typeof value.account === 'string' ? value.account : ''
const removed = (row: Row) => [true, 1, '1'].includes(row.deleted as boolean | number | string)
const labels: Record<string, string> = { 未开始: 'wait', 进行中: 'doing', 已暂停: 'pause', 已关闭: 'closed', 已完成: 'done',
  已取消: 'cancel', 激活: 'active', 已解决: 'resolved', 待评审: 'wait', 正常: 'normal', 已废弃: 'obsolete' }
const statusOf = (row: Row, allowed: string[]) => {
  const value = row.rawStatus ?? row.status
  const raw = typeof value === 'string' ? value : object(value) && typeof value.code === 'string' ? value.code : ''
  const status = labels[raw] ?? raw
  if (!allowed.includes(status)) throw new ZentaoError('禅道管理对象存在未知状态，本轮保留相关事项')
  return status
}
export function dateInput(value: unknown, present = true): DateInput {
  if (!present) return { state: 'unavailable', value: '' }
  if (value == null || typeof value === 'string' && (!value.trim() || /^0000-00-00/.test(value.trim()))) return { state: 'empty', value: '' }
  return { state: 'value', value: String(value).trim() }
}
export function mappedReleaseDate(row: Row, path: string, label: string): DateInput {
  if (path) {
    let value: unknown = row
    for (const part of path.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(part) || (!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) return dateInput(undefined, false)
      value = (value as Row)[part]
    }
    return dateInput(value)
  }
  // 自动识别只接受准确的中文字段名或标签，不猜测英文字段标识。
  if (Object.hasOwn(row, label)) return dateInput(row[label])
  if (object(row.customFields) && Object.hasOwn(row.customFields, label)) return dateInput(row.customFields[label])
  if (Array.isArray(row.customFields)) {
    const fields = row.customFields.filter((field) => object(field) && (field.label === label || field.name === label))
    if (fields.length > 1) return dateInput('自定义字段标签重复，请核对映射')
    if (fields.length === 1 && object(fields[0]) && Object.hasOwn(fields[0], 'value')) return dateInput(fields[0].value)
  }
  return dateInput(undefined, false)
}

export async function readManagementBatch(connection: ZentaoConnection, settings: ZentaoManagementSettings,
  trackedIds: string[], upstream: (path: string) => Promise<Row>, clean: (value: string) => string, options: ManagementReadOptions = {}): Promise<ManagementBatch> {
  const { instance } = zentaoIdentity(connection), collectedAt = new Date().toISOString()
  const startedAt = Date.now(), cache = options.cache ?? emptyCollectionCache()
  const diagnostics: CollectionDiagnostics = { requests: 0, cacheHits: 0, executions: 0, monitored: 0, deferred: 0, connectionFailures: 0, durationMs: 0, oldestAssociationCheck: null }
  trackedIds = [...new Set([...trackedIds, ...(options.trackedExecutionIds ?? [])])]
  let paused = '', connectionFailures = 0
  const request = async (path: string): Promise<Row> => {
    if (options.shouldStop?.()) paused = '采集已停止，保留已有记录'
    if (diagnostics.requests >= (options.requestBudget ?? 1500)) paused = '本轮禅道请求已达预算，未完成部分将在后续轮次继续核验'
    if (paused) throw new ZentaoError(paused)
    diagnostics.requests++
    try {
      const result = await upstream(path); connectionFailures = 0; return result
    } catch (error) {
      if (error instanceof ZentaoError && error.name === 'ZentaoConnectionError' && ++connectionFailures >= 3) {
        paused = '禅道连接连续失败，暂停本轮远端请求并保留已有记录'
      }
      throw error
    }
  }
  const text = (value: unknown) => typeof value === 'string' ? clean(value).trim().slice(0, 300) : ''
  async function list(path: string, key: string, paged = false): Promise<Row[]> {
    const rows: Row[] = [], seen = new Set<string>()
    let expected: number | null = null
    for (let page = 1; page <= 100; page++) {
      const result = await request(path + (path.includes('?') ? '&' : '?') + 'recPerPage=100&pageID=' + page)
      const entries = result[key]
      if (!Array.isArray(entries) && !object(entries)) throw new ZentaoError('禅道管理列表格式不兼容，保留上次判断')
      const current: unknown[] = Array.isArray(entries) ? entries : Object.values(entries)
      const pager = result.pager
      if (object(pager)) {
        const total = Number(pager.recTotal), perPage = Number(pager.recPerPage)
        if (!Number.isSafeInteger(total) || total < 0 || total > 10_000 || Number(pager.pageID) !== page ||
          !Number.isSafeInteger(perPage) || perPage < 1 || current.length > perPage || expected !== null && total !== expected) {
          throw new ZentaoError('禅道管理列表分页变化或缺页，保留上次判断')
        }
        expected = total
      }
      for (const value of current) {
        if (!object(value) || !idOf(value.id ?? value.case ?? value.caseID ?? value.story)) throw new ZentaoError('禅道管理对象编号无效')
        const id = idOf(value.id ?? value.case ?? value.caseID ?? value.story)
        if (seen.has(id)) throw new ZentaoError('禅道管理列表分页重复，保留上次判断')
        seen.add(id); rows.push(value)
      }
      if (expected !== null) {
        if (rows.length === expected) return rows
        if (!current.length || rows.length > expected) throw new ZentaoError('禅道管理列表缺页，保留上次判断')
      } else if (!paged || !current.length) return rows
    }
    throw new ZentaoError('禅道管理列表超过读取上限，保留上次判断')
  }
  const projects = await list('/projects?browseType=all', 'projects', true)
  const projectNames = new Map(projects.map((row) => [idOf(row.id), text(row.name)]))
  const rawExecutions = await list('/executions?status=all', 'executions', true)
  for (let index = 0; index < rawExecutions.length; index++) {
    const row = rawExecutions[index]
    if (row.type !== 'sprint' || ['end', 'realEnd'].every((key) => Object.hasOwn(row, key))) continue
    try {
      const detail = await request('/executions/' + idOf(row.id))
      if (!object(detail.execution) || idOf(detail.execution.id) !== idOf(row.id)) throw new ZentaoError('冲刺日期详情编号不匹配')
      rawExecutions[index] = { ...row, ...detail.execution }
    } catch { /* 未返回或读取失败的日期保留 unavailable，不能作为空日期兜底。 */ }
  }
  const knownIds = new Set(rawExecutions.map((row) => idOf(row.id)))
  for (const id of new Set(trackedIds)) if (!knownIds.has(id) && idOf(id)) {
    try {
      const detail = await request('/executions/' + id)
      if (!object(detail.execution) || idOf(detail.execution.id) !== id) throw new ZentaoError('已跟踪冲刺详情编号不匹配')
      rawExecutions.push(detail.execution)
    } catch {
      // 读取不到不等于已删除；返回不完整占位，存储层保留原快照。
      rawExecutions.push({ id, name: '已跟踪冲刺 ' + id, status: 'unreadable', project: '0', type: 'sprint' })
    }
  }
  const executions: ManagementExecution[] = rawExecutions.filter((row) => row.type === 'sprint' || trackedIds.includes(idOf(row.id))).map((row) => {
    const id = idOf(row.id), projectId = idOf(row.project)
    const status = row.status === 'unreadable' ? 'unreadable' : statusOf(row, ['wait', 'doing', 'pause', 'suspended', 'done', 'closed', 'cancel'])
    return { type: 'execution', id, title: text(row.name) || '冲刺 ' + id, owner: clean(account(row.QD) || account(row.PM)),
      url: instance + '/execution-view-' + id + '.html', projectId, project: projectNames.get(projectId) || text(row.projectName) || '项目 ' + projectId,
      status, begin: dateInput(row.begin, Object.hasOwn(row, 'begin')), end: dateInput(row.end, Object.hasOwn(row, 'end')),
      realEnd: dateInput(row.realEnd, Object.hasOwn(row, 'realEnd')), closedAt: zentaoTimestamp(row.closedDate) ?? zentaoTimestamp(row.realEnd),
      removed: removed(row) || status === 'cancel' }
  })
  const associations: Record<string, string[]> = {}, scopes: ManagementScope[] = [], issues: string[] = []
  let relationsComplete = true
  const associationGaps = new Set<string>(), cachedAssociationIds = new Set<string>()
  const cutoff = Date.parse(collectedAt) - 30 * 86_400_000
  const details = new Map<string, Row>()
  const isMonitored = (execution: ManagementExecution) => trackedIds.includes(execution.id) || !['closed', 'done', 'cancel'].includes(execution.status) ||
    !!execution.closedAt && Date.parse(execution.closedAt) >= cutoff
  diagnostics.executions = executions.length
  diagnostics.monitored = executions.filter(isMonitored).length
  const ordered = [...executions].sort((a, b) => Number(isMonitored(b)) - Number(isMonitored(a)))
  const resumeAt = ordered.findIndex((entry) => entry.id === cache.nextExecutionId)
  const queue = resumeAt > 0 ? [...ordered.slice(resumeAt), ...ordered.slice(0, resumeAt)] : ordered
  delete cache.nextExecutionId
  for (const execution of queue) {
    const monitored = isMonitored(execution)
    if (paused || options.shouldStop?.()) {
      cache.nextExecutionId ??= execution.id
      diagnostics.deferred++
      associationGaps.add(execution.id); relationsComplete = false
      if (monitored) scopes.push({ execution, stories: [], cases: [], testtasks: [], bugs: [],
        readable: { stories: false, cases: false, testtasks: false, bugs: false },
        issues: [paused || '采集已停止，保留已有记录'], collectedAt })
      continue
    }
    const scope: ManagementScope = { execution, stories: [], cases: [], testtasks: [], bugs: [],
      readable: { stories: true, cases: true, testtasks: true, bugs: true }, issues: [], collectedAt }
    if (execution.status === 'unreadable') {
      associationGaps.add(execution.id)
      relationsComplete = false; scope.readable = { stories: false, cases: false, testtasks: false, bugs: false }
      scope.issues.push('已跟踪冲刺读取失败，保留上次判断'); scopes.push(scope); continue
    }
    if (execution.removed) { if (monitored) scopes.push(scope); continue }
    try {
      const key = 'associations:' + execution.id, signature = JSON.stringify(execution)
      const previous = cache.entries[key]
      const useCache = !monitored && !options.fullRefresh && previous?.signature === signature &&
        Date.now() - previous.checkedAt < 86_400_000 && previous.checkedAt <= Date.now()
      const rows = useCache ? previous.rows : await list('/executions/' + execution.id + '/stories', 'stories')
      if (useCache) {
        diagnostics.cacheHits++
        cachedAssociationIds.add(execution.id)
        const checked = new Date(previous.checkedAt).toISOString()
        if (!diagnostics.oldestAssociationCheck || checked < diagnostics.oldestAssociationCheck) diagnostics.oldestAssociationCheck = checked
        // 缓存保留跨冲刺关联，但不能作为本轮已完整复核的证明。
        associationGaps.add(execution.id); relationsComplete = false
      } else if (!monitored) {
        cache.entries[key] = { signature, checkedAt: Date.now(), rows: rows.map((row) => ({ id: idOf(row.story) || idOf(row.id) })) }
      }
      for (let row of rows) {
        const id = idOf(row.story) || idOf(row.id)
        if (!associations[id]) associations[id] = []
        associations[id].push(execution.id)
        if (!monitored) continue
        if (mappedReleaseDate(row, settings.plannedReleaseField, '计划上线时间').state === 'unavailable' ||
          mappedReleaseDate(row, settings.actualReleaseField, '实际上线时间').state === 'unavailable') {
          if (!details.has(id)) {
            const detail = await request('/stories/' + id)
            if (!object(detail.story) || idOf(detail.story.id) !== id) throw new ZentaoError('需求详情格式或编号不匹配')
            details.set(id, detail.story)
          }
          row = { ...row, ...details.get(id) }
        }
        const status = statusOf(row, ['draft', 'reviewing', 'active', 'closed', 'changing', 'done'])
        const story: ManagementStory = { type: 'story', id, title: text(row.title) || '需求 ' + id, owner: clean(account(row.assignedTo)),
          url: instance + '/story-view-' + id + '.html', status, version: String(row.version ?? '1'),
          parent: [true, 1, '1'].includes(row.isParent as boolean | number | string),
          removed: removed(row) || ['cancel', 'duplicate', 'postponed', 'willnotdo'].includes(String(row.closedReason ?? '')),
          plannedReleaseAt: mappedReleaseDate(row, settings.plannedReleaseField, '计划上线时间'),
          actualReleaseAt: mappedReleaseDate(row, settings.actualReleaseField, '实际上线时间'), executionIds: [] }
        story.releaseFields = { planned: settings.plannedReleaseField || '计划上线时间', actual: settings.actualReleaseField || '实际上线时间' }
        scope.stories.push(story)
      }
    } catch (error) {
      if (paused) { cache.nextExecutionId ??= execution.id; diagnostics.deferred++ }
      associationGaps.add(execution.id)
      relationsComplete = false; scope.readable.stories = false; scope.stories = []
      scope.issues.push(error instanceof ZentaoError ? error.message : '需求读取失败，保留上次判断')
      issues.push('冲刺 ' + execution.id + ' 的需求关联未完整读取')
    }
    if (!monitored) continue
    for (const resource of ['cases', 'testtasks', 'bugs'] as const) {
      try {
        const key = resource === 'cases' ? 'testcases' : resource
        const rows = await list('/executions/' + execution.id + '/' + key + '?browseType=all', key, resource !== 'testtasks')
        for (let row of rows) {
          const id = idOf(resource === 'cases' ? row.caseID ?? row.case ?? row.id : row.id)
          const creatorKey = 'case-creator:' + id
          const creatorSignature = JSON.stringify([row.version ?? null, row.createdDate ?? null, row.lastEditedDate ?? null])
          const creator = cache.entries[creatorKey]
          // 只复用创建人和创建日期；评审、变更标记、版本等可变信息始终来自本轮响应。
          if (resource === 'cases' && row.status !== undefined && row.version !== undefined && Object.hasOwn(row, 'lastEditedDate') && row.createdBy === undefined && !options.fullRefresh &&
            creator?.signature === creatorSignature && Date.now() - creator.checkedAt < 3_600_000 && creator.checkedAt <= Date.now()) {
            row = { ...creator.rows[0], ...row, createdBy: creator.rows[0].createdBy }
            diagnostics.cacheHits++
          }
          if (resource === 'cases' && (row.status === undefined || row.createdBy === undefined)) {
            const detail = await request('/testcases/' + id)
            const testcase = detail.testcase ?? detail.case
            if (!object(testcase) || idOf(testcase.id) !== id) throw new ZentaoError('用例详情格式或编号不匹配')
            if (Object.hasOwn(testcase, 'createdBy')) cache.entries[creatorKey] = { signature: creatorSignature, checkedAt: Date.now(), rows: [{
              createdBy: clean(account(testcase.createdBy)), createdDate: text(testcase.createdDate),
            }] }
            row = { ...row, ...testcase }
          }
          const base = { id, title: text(row.title ?? row.name) || '事项 ' + id, owner: clean(account(row.owner ?? row.assignedTo ?? row.createdBy)),
            url: instance + '/' + (resource === 'cases' ? 'testcase' : resource === 'testtasks' ? 'testtask' : 'bug') + '-view-' + id + '.html' }
          if (resource === 'cases') {
            const status = statusOf(row, ['wait', 'normal', 'obsolete', 'blocked'])
            scope.cases.push({ ...base, type: 'case', status, removed: removed(row) || status === 'obsolete',
              storyId: idOf(row.story), needConfirm: [true, 1, '1'].includes(row.needconfirm as boolean | number | string) ||
                !!row.storyVersion && !!scope.stories.find((story) => story.id === idOf(row.story) && story.version !== String(row.storyVersion)),
              createdBy: clean(account(row.createdBy)), createdAt: zentaoTimestamp(row.createdDate),
              editedAt: zentaoTimestamp(row.lastEditedDate), version: String(row.version ?? '1'),
              reviewSubmittedAt: zentaoTimestamp(row.reviewSubmittedDate) })
          } else if (resource === 'testtasks') {
            const status = statusOf(row, ['wait', 'doing', 'done', 'closed', 'blocked', 'cancel'])
            scope.testtasks.push({ ...base, type: 'testtask', status, removed: removed(row) || status === 'cancel' })
          } else {
            const status = statusOf(row, ['active', 'resolved', 'closed'])
            const severity = Number(row.severity)
            if (!Number.isSafeInteger(severity) || severity < 1) throw new ZentaoError('Bug 缺少有效严重程度，保留严重缺陷判断')
            scope.bugs.push({ ...base, type: 'bug', status, severity, storyId: idOf(row.story),
              removed: removed(row) || ['duplicate', 'willnotfix', 'notrepro', 'bydesign'].includes(String(row.resolution ?? '')) })
          }
        }
      } catch (error) {
        scope.readable[resource] = false; scope[resource] = []
        scope.issues.push(error instanceof ZentaoError ? error.message : '管理数据读取失败，保留上次判断')
      }
    }
    scopes.push(scope)
    if (paused) cache.nextExecutionId ??= execution.id
  }
  diagnostics.connectionFailures = connectionFailures
  diagnostics.durationMs = Date.now() - startedAt
  if (paused) issues.push(paused)
  const verifiedAt = new Date().toISOString()
  for (const scope of scopes) {
    scope.collectedAt = verifiedAt
    for (const story of scope.stories) story.executionIds = [...new Set(associations[story.id] ?? [])]
  }
  return { instance, account: connection.account, collectedAt: verifiedAt, executions, scopes, associations, relationsComplete,
    cachedAssociationIds: [...cachedAssociationIds], associationGaps: [...associationGaps], issues: [...new Set(issues)], collectionDiagnostics: diagnostics }
}
