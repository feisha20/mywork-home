import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZentaoV2Client, zentaoTimestamp } from './zentao.js'

const connection = { baseUrl: 'https://pm.example/zentao/', account: 'linjt', password: '接口测试密码' }
const bug = (id: number, status = 'active', assignedTo: unknown = 'linjt') => ({ id: String(id), title: `测试 Bug ${id}`, status, assignedTo, deleted: '0', openedDate: '2026-09-21 20:00:01', assignedDate: '2026-09-22 11:14:49', pri: '2' })
const task = (id: number, status = 'doing') => ({ id: String(id), name: `测试任务 ${id}`, status, assignedTo: { account: 'linjt' }, deleted: false, openedDate: '2026-09-22 11:14:49' })
const list = (key: 'bugs' | 'tasks', rows: unknown, total: number, page = 1, perPage = 100) => ({ status: 'success', [key]: rows, pager: { recTotal: total, pageID: page, recPerPage: perPage } })
const response = (value: unknown) => new Response(JSON.stringify(value))
function mockApi(bugs: unknown, tasks: unknown) {
  const fetch = vi.fn().mockResolvedValueOnce(response({ status: 'success', token: '测试令牌', user: { account: 'linjt' } }))
    .mockResolvedValueOnce(response(bugs)).mockResolvedValueOnce(response(tasks))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(() => vi.unstubAllGlobals())

describe('禅道 V2 个人待办采集', () => {
  it('只调用 V2，兼容编号对象和数组，按本人及状态筛选，已解决 Bug 保留待验证', async () => {
    const fetch = mockApi(list('bugs', { 1: bug(1), 2: bug(2, 'resolved'), 3: bug(3, 'closed'), 4: bug(4, 'active', '其他人') }, 4),
      list('tasks', [task(1), task(2, 'wait'), task(3, 'pause'), task(4, 'done'), task(5, 'cancel'), { ...task(6), deleted: '1' }], 6))
    const result = await new ZentaoV2Client(connection).readWork()
    expect(result).toMatchObject({ instance: 'https://pm.example/zentao', account: 'linjt', bugs: 2, tasks: 3 })
    expect(result.items.filter((item) => item.state === 'pending').map((item) => item.reference)).toEqual(['BUG-1', 'BUG-2', 'TASK-1', 'TASK-2', 'TASK-3'])
    expect(result.items[0].id).not.toBe(result.items[4].id)
    expect(result.items[0].createdAt).toBe('2026-09-21T12:00:01.000Z')
    expect(result.items[0].zentao.url).toBe('https://pm.example/zentao/bug-view-1.html')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ account: connection.account, password: connection.password })
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/zentao/api.php/v2/users/login', '/zentao/api.php/v2/my/work/bug', '/zentao/api.php/v2/my/work/task'])
    expect(fetch.mock.calls[1][1].headers.token).toBe('测试令牌')
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('type')).toBe('assignedTo')
    expect(fetch.mock.calls.every(([, options]) => options.redirect === 'error')).toBe(true)
  })
  it('按服务端分页完整读取，重复采集保留稳定编号和真实完成时间', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ status: 'success', token: '测试令牌' }))
      .mockResolvedValueOnce(response(list('bugs', [bug(1)], 2, 1, 1)))
      .mockResolvedValueOnce(response(list('bugs', [bug(2)], 2, 2, 1)))
      .mockResolvedValueOnce(response(list('tasks', [{ ...task(1, 'done'), finishedDate: '2026-10-05 16:20:00' }], 1)))
    vi.stubGlobal('fetch', fetch)
    const one = await new ZentaoV2Client(connection).readWork()
    expect(new URL(fetch.mock.calls[2][0]).searchParams.get('pageID')).toBe('2')
    expect(one.items.at(-1)?.completedAt).toBe('2026-10-05T08:20:00.000Z')
    mockApi(list('bugs', [{ ...bug(1), title: '更新后的 Bug 标题' }, bug(2)], 2), list('tasks', [], 0))
    const two = await new ZentaoV2Client(connection).readWork()
    expect(two.items[0].id).toBe(one.items[0].id)
  })
  it('失败、缺页、重复页和未知状态拒绝整轮快照，错误不包含账号密码或上游正文', async () => {
    for (const payload of [
      { status: 'fail', message: `私密错误 ${connection.password}` },
      { status: 'success', bugs: [] },
      list('bugs', [], 2), list('bugs', [bug(1)], 1, 2),
      list('bugs', [bug(1, 'unknown')], 1), list('bugs', [bug(1), bug(1)], 2),
      { ...list('bugs', [bug(1)], 1), mode: 'task' },
    ]) {
      const fetch = mockApi(payload, list('tasks', [], 0))
      const error = await new ZentaoV2Client(connection).readWork().catch((cause: Error) => cause)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(connection.password)
      expect(String(error)).not.toContain('私密错误')
      expect(fetch).toHaveBeenCalledTimes(2)
    }
    const fetch = mockApi(list('bugs', [], 0), list('tasks', [], 0))
    fetch.mockReset().mockResolvedValue(new Response(`私密错误 ${connection.password}`, { status: 401 }))
    await expect(new ZentaoV2Client(connection).readWork()).rejects.toThrow('认证失败')
  })
  it('截断或变化中的分页不提交，密码及令牌即使出现在标题也脱敏', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ status: 'success', token: '测试令牌' }))
      .mockResolvedValueOnce(response(list('bugs', [bug(1)], 2, 1, 1)))
      .mockResolvedValueOnce(response(list('bugs', [bug(2)], 3, 2, 1)))
    vi.stubGlobal('fetch', fetch)
    await expect(new ZentaoV2Client(connection).readWork()).rejects.toThrow('列表已变化')
    mockApi(list('bugs', [{ ...bug(1), title: `检查 ${connection.password} 测试令牌\0` }], 1), list('tasks', [], 0))
    const snapshot = await new ZentaoV2Client(connection).readWork()
    expect(snapshot.items[0].title).not.toContain(connection.password)
    expect(snapshot.items[0].title).not.toContain('测试令牌')
    expect(snapshot.items[0].title).not.toContain('\0')
  })
  it('禅道无时区日期按北京时间解析，空值和零日期不当成真实时间', () => {
    expect(zentaoTimestamp('2026-10-06 08:00:00')).toBe('2026-10-06T00:00:00.000Z')
    expect(zentaoTimestamp('2026-10-06T01:00:00Z')).toBe('2026-10-06T01:00:00.000Z')
    for (const value of ['', null, '0000-00-00 00:00:00', '1970-01-01', '无效日期']) expect(zentaoTimestamp(value)).toBeNull()
  })
})
