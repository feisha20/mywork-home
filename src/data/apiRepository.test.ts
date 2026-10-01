import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoState } from '../domain/workbench'
import { migrateLegacyTasks, createTask } from './apiRepository'

afterEach(() => { vi.unstubAllGlobals() })
describe('旧缓存迁移与请求失败', () => {
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
})
