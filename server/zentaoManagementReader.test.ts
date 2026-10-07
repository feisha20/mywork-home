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
