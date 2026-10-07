import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoState } from '../domain/workbench'
import { migrateLegacyTasks, createTask, updateTaskPersonal, generateDailyReport, loadOrCreateDailyReport } from './apiRepository'

afterEach(() => { vi.unstubAllGlobals() })
describe('旧缓存迁移与请求失败', () => {
  it('新建个人待办与修改分类独立于完成状态', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ isPersonal: true }) })
    vi.stubGlobal('fetch', fetch)
    await createTask('安排家庭出行', true)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ title: '安排家庭出行', isPersonal: true })
    await updateTaskPersonal('id/one', false)
    expect(fetch.mock.calls[1][0]).toBe('/api/tasks/id%2Fone/personal')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ isPersonal: false })
  })
  it('仅迁移手工事项，保留原日期；成功前不写迁移标记', async () => {
    const state = createDemoState(new Date())
    state.tasks.push({ id: 'b65c0ac8-bf3e-4ae5-b50c-3c41ee212ef0', reference: 'TASK-old', source: 'manual', title: '原手工事项', createdAt: '2026-09-26T01:00:00Z', completedAt: '2026-09-27T01:00:00Z' })
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: (key: string) => key.endsWith('.migrated') ? null : JSON.stringify(state), setItem })
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: '服务未连接' }) })
    vi.stubGlobal('fetch', fetch)
    await expect(migrateLegacyTasks()).rejects.toThrow('服务未连接'); expect(setItem).not.toHaveBeenCalled()
    fetch.mockResolvedValue({ ok: true, json: async () => ({ imported: 1 }) })
    await migrateLegacyTasks()
    const sent = JSON.parse(fetch.mock.calls[1][1].body)
    expect(sent.tasks).toEqual([state.tasks.at(-1)]); expect(setItem).toHaveBeenCalledOnce()
  })
  it('损坏缓存不变成示例写入数据库', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', { getItem: (key: string) => key.endsWith('.migrated') ? null : '{损坏', setItem: vi.fn() })
    expect(await migrateLegacyTasks()).toContain('格式无效'); expect(fetch).not.toHaveBeenCalled()
  })
  it('网络失败返回可理解的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    await expect(createTask('事项')).rejects.toThrow('无法连接工作台服务')
  })
  it('根据所选日期请求日报，模型错误可读，关闭窗口时可以取消等待', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: '工作日报生成超时，请重新生成' }) })
    vi.stubGlobal('fetch', fetch)
    await expect(generateDailyReport('2026-09-30')).rejects.toThrow('工作日报生成超时')
    expect(fetch.mock.calls[0][0]).toBe('/api/daily-reports')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ day: '2026-09-30' })
    const controller = new AbortController()
    fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))))
    const pending = generateDailyReport('2026-10-01', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('已有日报再次打开只读取保存内容，未保存时才生成，补充使用明确模式', async () => {
    const saved = { day: '2026-10-01', revision: 1 }
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => saved })
    vi.stubGlobal('fetch', fetch)
    expect(await loadOrCreateDailyReport(saved.day)).toEqual(saved)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toBe('/api/daily-reports/2026-10-01')
    expect(fetch.mock.calls[0][1].method).toBeUndefined()
    fetch.mockResolvedValueOnce({ ok: true, json: async () => null })
    await loadOrCreateDailyReport(saved.day)
    expect(fetch.mock.calls[2][1].method).toBe('POST')
    await generateDailyReport(saved.day, undefined, 'append')
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ day: saved.day, mode: 'append' })
  })
})
