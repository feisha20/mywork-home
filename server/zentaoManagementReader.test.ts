import { emptyCollectionCache } from './zentaoCollectionCache.js'
import { evaluateManagement } from './zentaoManagement.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readManagementBatch } from './zentaoManagementReader.js'
import { defaultZentaoManagement } from '../shared/zentaoManagement.js'
import { ZentaoError, ZentaoV2Client } from './zentao.js'

const connection = { baseUrl: 'https://pm.example/', account: 'manager', password: '测试密码' }
const config = { ...defaultZentaoManagement, plannedReleaseField: 'planned', actualReleaseField: 'actual' }
const execution = (id: number, patch = {}) => ({ id, project: 1, name: '冲刺' + id, type: 'sprint', status: 'doing', begin: '2026-10-01', end: '2026-10-08', realEnd: '0000-00-00', ...patch })
function mockReader(override?: (path: string) => Record<string, unknown> | undefined) {
  return vi.fn(async (path: string) => {
    const custom = override?.(path)
    if (custom) return custom
    const url = new URL(path, connection.baseUrl), page = Number(url.searchParams.get('pageID') ?? 1), route = url.pathname
    const list = (key: string, entries: unknown[]) => ({ [key]: entries, pager: { recTotal: entries.length, recPerPage: 100, pageID: page } })
    if (route === '/projects') return list('projects', [{ id: 1, name: '测试项目' }])
    if (route === '/executions') return list('executions', [execution(10), execution(11, { status: 'closed', closedDate: '2020-01-01', end: '2026-10-12', realEnd: '2020-01-01' })])
    if (/\/executions\/\d+\/stories$/.test(route)) return { stories: [{ id: 101, title: '测试需求', status: 'active', version: 2, planned: null, actual: '' }] }
    if (route.endsWith('/testcases')) return list('testcases', [{ caseID: 201, title: '登录用例', story: 101, storyVersion: 1, status: 'wait', createdBy: { account: 'qa1' }, createdDate: '2026-10-04 10:00:00', lastEditedDate: '2026-10-05 10:00:00' }])
    if (route.endsWith('/testtasks')) return { testtasks: [{ id: 401, name: '测试单', status: '已完成', rawStatus: 'done' }] }
    if (route.endsWith('/bugs')) return list('bugs', [])
    throw new Error('未配置测试接口 ' + route)
  })
}
const read = (request: ReturnType<typeof mockReader>, trackedIds: string[] = []) => readManagementBatch(connection, config, trackedIds, request, (value) => value)
afterEach(() => vi.unstubAllGlobals())

describe('禅道管理采集完整性', () => {
  it('兼容自定义严重程度5，仅规则中的1／2属于严重缺陷', async () => {
    const batch = await read(mockReader((path) => {
      if (path.includes('/bugs?')) return { bugs: [{ id: 301, title: '普通缺陷', status: 'active', severity: '5' }], pager: { recTotal: 1, recPerPage: 100, pageID: 1 } }
    }))
    expect(batch.scopes[0].readable.bugs).toBe(true)
    expect(batch.scopes[0].bugs[0].severity).toBe(5)
  })
  it('字段核对只返回标识和填写状态，支持嵌套与数组路径，不返回需求内容或字段值', async () => {
    const json = (value: unknown) => new Response(JSON.stringify({ status: 'success', ...value as object }))
    const fetch = vi.fn().mockResolvedValueOnce(json({ token: '核对令牌' }))
      .mockResolvedValueOnce(json({ executions: [execution(10)] }))
      .mockResolvedValueOnce(json({ stories: [{ id: 101 }] }))
      .mockResolvedValueOnce(json({ story: { id: 101, title: '不返回的需求正文', openedDate: '2026-10-01 10:00:00',
        customFields: [{ label: '计划上线时间', value: '2026-10-10' }, { label: '实际上线时间', value: '' }] } }))
    vi.stubGlobal('fetch', fetch)
    const preview = await new ZentaoV2Client(connection).inspectManagementFields({
      ...config, plannedReleaseField: 'customFields.0.value', actualReleaseField: 'customFields.1.value',
    })
    expect(preview).toMatchObject({ storyId: '101', planned: 'value', actual: 'empty' })
    expect(preview.candidates).toContainEqual({ path: 'customFields.0.value', label: '计划上线时间' })
    expect(JSON.stringify(preview)).not.toContain('不返回的需求正文')
    expect(JSON.stringify(preview)).not.toContain('2026-10-10')
    expect(JSON.stringify(preview)).not.toContain('核对令牌')
    expect(fetch.mock.calls.slice(1).every((call) => call[1].method === 'GET')).toBe(true)
  })
  it('补齐旧冲刺关联后选最晚兜底；读取用例创建人与测试单原始状态', async () => {
    const request = mockReader(), batch = await read(request)
    expect(batch.scopes).toHaveLength(1)
    expect(batch.associations['101']).toEqual(['10', '11'])
    expect(batch.scopes[0].stories[0].executionIds).toEqual(['10', '11'])
    expect(batch.scopes[0].cases[0]).toMatchObject({ id: '201', createdBy: 'qa1', needConfirm: true })
    expect(batch.scopes[0].testtasks[0].status).toBe('done')
    expect(request.mock.calls.some(([path]) => path.startsWith('/executions/11/stories'))).toBe(true)
    expect(request.mock.calls.some(([path]) => path.startsWith('/executions/11/testcases'))).toBe(false)
  })
  it('纳入未结束及最近关闭冲刺，超出30天的已跟踪冲刺仍继续采集', async () => {
    const batch = await read(mockReader(), ['11'])
    expect(batch.scopes.map((scope) => scope.execution.id)).toEqual(['10', '11'])
  })
  it('字段未返回补查详情，仍未返回保持 unavailable', async () => {
    const batch = await read(mockReader((path) => {
      if (path.includes('/stories?')) return { stories: [{ id: 101, title: '需求', status: 'active' }] }
      if (path === '/stories/101') return { story: { id: 101, title: '需求', status: 'active', planned: '' } }
    }))
    expect(batch.scopes[0].stories[0].plannedReleaseAt.state).toBe('empty')
    expect(batch.scopes[0].stories[0].actualReleaseAt.state).toBe('unavailable')
    expect(batch.scopes[0].readable.stories).toBe(true)
  })
  it('局部权限失败只标记相关资源，保留其他冲刺的完整结果', async () => {
    const request = mockReader((path) => {
      if (path.includes('/executions/10/testcases?')) throw new ZentaoError('测试用例无读取权限')
    })
    const batch = await read(request, ['11'])
    expect(batch.scopes[0].readable.cases).toBe(false)
    expect(batch.scopes[0].issues).toContain('测试用例无读取权限')
    expect(batch.scopes[1].readable.cases).toBe(true)
    expect(batch.relationsComplete).toBe(true)
  })
  it('重复页与缺页不能当作完整同步', async () => {
    const duplicate = await read(mockReader((path) => {
      if (path.includes('/testcases?')) {
        const pageID = Number(new URL(path, connection.baseUrl).searchParams.get('pageID'))
        return { testcases: [{ id: 201 }], pager: { recTotal: 2, recPerPage: 1, pageID } }
      }
    }))
    expect(duplicate.scopes[0].readable.cases).toBe(false)
    const missing = mockReader((path) => {
      if (path.startsWith('/projects?')) {
        const pageID = Number(new URL(path, connection.baseUrl).searchParams.get('pageID'))
        return { projects: pageID === 1 ? [{ id: 1, name: '项目' }] : [], pager: { recTotal: 2, recPerPage: 1, pageID } }
      }
    })
    await expect(read(missing)).rejects.toThrow('缺页')
  })
  it('没有分页元信息的分页接口继续读取到空页', async () => {
    const batch = await read(mockReader((path) => {
      if (path.startsWith('/projects?')) {
        const pageID = Number(new URL(path, connection.baseUrl).searchParams.get('pageID'))
        return { projects: pageID === 1 ? [{ id: 1, name: '项目' }] : pageID === 2 ? [{ id: 2, name: '第二项目' }] : [] }
      }
    }))
    expect(batch.relationsComplete).toBe(true)
  })
  it('已跟踪冲刺列表缺失且详情失败，保留不完整占位', async () => {
    const batch = await read(mockReader(), ['20'])
    expect(batch.scopes.find((scope) => scope.execution.id === '20')).toMatchObject({
      execution: { status: 'unreadable' }, readable: { stories: false, cases: false, testtasks: false, bugs: false },
    })
    expect(batch.relationsComplete).toBe(false)
  })
})


describe('禅道采集请求预算与持久化缓存', () => {
  const cachedRead = (request: ReturnType<typeof mockReader>, options = {}) =>
    readManagementBatch(connection, config, [], request, (value) => value, options)
  it('历史关联跨重启复用，仍保留跨冲刺关系并标明历史核验时间', async () => {
    const cache = emptyCollectionCache()
    const historical = (path: string) => path.startsWith('/executions?') ? {
      executions: [execution(10), execution(11, { status: 'closed', closedDate: '2020-01-01', end: '2020-01-01', realEnd: '2020-01-01' })],
      pager: { recTotal: 2, recPerPage: 100, pageID: 1 },
    } : undefined
    const first = mockReader(historical)
    const before = await cachedRead(first, { cache })
    const second = mockReader(historical)
    const after = await cachedRead(second, { cache: JSON.parse(JSON.stringify(cache)) })
    expect(second.mock.calls.some(([path]) => path.startsWith('/executions/11/stories'))).toBe(false)
    expect(after.associations).toEqual(before.associations)
    expect(after.relationsComplete).toBe(false)
    expect(after.associationGaps).toContain('11')
    expect(after.collectionDiagnostics?.oldestAssociationCheck).toBeTruthy()
    expect(after.collectionDiagnostics!.requests).toBeLessThan(before.collectionDiagnostics!.requests)
    // 更早的历史关联缓存不会改变最晚冲刺日期选择，风险结果保持一致。
    expect(evaluateManagement(after, config).risks).toEqual(evaluateManagement(before, config).risks)
  })

  it('813个冲刺重复同步时复用历史关联，风险结果一致且请求减少超过九成', async () => {
    const cache = emptyCollectionCache()
    const request = mockReader((path) => {
      if (!path.startsWith('/executions?')) return
      const page = Number(new URL(path, connection.baseUrl).searchParams.get('pageID'))
      const all = [execution(10), ...Array.from({ length: 812 }, (_, i) => execution(11 + i, {
        status: 'closed', closedDate: '2020-01-01', end: '2020-01-01', realEnd: '2020-01-01',
      }))]
      return { executions: all.slice((page - 1) * 100, page * 100), pager: { recTotal: all.length, recPerPage: 100, pageID: page } }
    })
    const first = await cachedRead(request, { cache })
    const second = await cachedRead(request, { cache: JSON.parse(JSON.stringify(cache)) })
    expect(second.collectionDiagnostics!.requests).toBeLessThan(first.collectionDiagnostics!.requests / 10)
    expect(second.collectionDiagnostics?.cacheHits).toBe(812)
    expect(evaluateManagement(second, config).risks).toEqual(evaluateManagement(first, config).risks)
  })
  it('不能用缓存中可能已撤销的历史关联自动解除上线风险', async () => {
    const cache = emptyCollectionCache(), request = mockReader((path) => path.startsWith('/executions?') ? {
      executions: [execution(10), execution(11, { status: 'closed', closedDate: '2020-01-01', end: '2027-01-01', realEnd: '2020-01-01' })],
      pager: { recTotal: 2, recPerPage: 100, pageID: 1 },
    } : undefined)
    await cachedRead(request, { cache })
    const second = await cachedRead(request, { cache })
    const evaluation = evaluateManagement(second, config)
    expect(evaluation.datesByStory['101'].actual.state).toBe('unavailable')
    expect(evaluation.evaluatedKeys).not.toContain('release:101')
  })
  it('历史缓存到期、冲刺属性变化、手动完整刷新时重新读取', async () => {
    const cache = emptyCollectionCache()
    await cachedRead(mockReader(), { cache })
    cache.entries['associations:11'].checkedAt -= 86_400_001
    const expired = mockReader(); await cachedRead(expired, { cache })
    expect(expired.mock.calls.some(([path]) => path.startsWith('/executions/11/stories'))).toBe(true)
    const forced = mockReader(); await cachedRead(forced, { cache, fullRefresh: true })
    expect(forced.mock.calls.some(([path]) => path.startsWith('/executions/11/stories'))).toBe(true)
    const changed = mockReader((path) => path.startsWith('/executions?') ? {
      executions: [execution(10), execution(11, { status: 'doing' })], pager: { recTotal: 2, recPerPage: 100, pageID: 1 },
    } : undefined)
    await cachedRead(changed, { cache })
    expect(changed.mock.calls.some(([path]) => path.startsWith('/executions/11/testcases'))).toBe(true)
  })
  it('只缓存创建人元数据，列表中的最新评审状态、变更标记仍生效', async () => {
    let status = 'wait', version = 1
    const cache = emptyCollectionCache()
    const request = mockReader((path) => {
      if (path.includes('/testcases?')) return { testcases: [{ caseID: 201, story: 101, status, version, lastEditedDate: null, needconfirm: 1 }], pager: { recTotal: 1, recPerPage: 100, pageID: 1 } }
      if (path === '/testcases/201') return { testcase: { id: 201, status, version, createdBy: { account: 'qa1' }, createdDate: '2026-10-01', steps: '不应缓存正文' } }
    })
    await cachedRead(request, { cache }); request.mockClear(); status = 'normal'
    const second = await cachedRead(request, { cache })
    expect(request.mock.calls.some(([path]) => path === '/testcases/201')).toBe(false)
    expect(second.scopes[0].cases[0]).toMatchObject({ status: 'normal', createdBy: 'qa1', needConfirm: true })
    expect(JSON.stringify(cache)).not.toContain('不应缓存正文')
    request.mockClear(); version = 2; await cachedRead(request, { cache })
    expect(request.mock.calls.some(([path]) => path === '/testcases/201')).toBe(true)
  })
  it('缺少评审状态时不能使用缓存冒充最新详情', async () => {
    const cache = emptyCollectionCache(), request = mockReader((path) => {
      if (path.includes('/testcases?')) return { testcases: [{ caseID: 201, story: 101 }], pager: { recTotal: 1, recPerPage: 100, pageID: 1 } }
      if (path === '/testcases/201') return { testcase: { id: 201, status: 'wait', createdBy: 'qa1' } }
    })
    await cachedRead(request, { cache }); request.mockClear(); await cachedRead(request, { cache })
    expect(request.mock.calls.some(([path]) => path === '/testcases/201')).toBe(true)
  })
  it('请求达到预算后保留未知状态，下一轮从未完成冲刺续采', async () => {
    const cache = emptyCollectionCache(), request = mockReader()
    const first = await cachedRead(request, { cache, requestBudget: 3 })
    expect(request).toHaveBeenCalledTimes(3)
    expect(first.scopes[0].readable.cases).toBe(false)
    expect(first.issues.join('')).toContain('预算')
    expect(cache.nextExecutionId).toBe('10')
    const next = mockReader(); await cachedRead(next, { cache, requestBudget: 100 })
    expect(cache.nextExecutionId).toBeUndefined()
    expect(next.mock.calls.some(([path]) => path.startsWith('/executions/10/testcases'))).toBe(true)
  })
  it('连续三次连接失败后不再继续发起网络请求', async () => {
    const request = mockReader((path) => {
      if (path.startsWith('/executions/10/')) throw Object.assign(new ZentaoError('连接断开'), { name: 'ZentaoConnectionError' })
    })
    const batch = await cachedRead(request)
    expect(request).toHaveBeenCalledTimes(5)
    expect(batch.collectionDiagnostics?.connectionFailures).toBe(3)
    expect(batch.issues.join('')).toContain('连续失败')
    expect(batch.scopes[0].readable).toEqual({ stories: false, cases: false, testtasks: false, bugs: false })
  })
})
