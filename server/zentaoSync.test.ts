import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.js'
import { SettingsService } from './settings.js'
import { settingsDraft } from '../src/domain/settings.js'
import { SyncService } from './sync.js'
import type { Store } from './store.js'
import type { SyncRun } from '../shared/contracts.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'workbench-zentao-sync-')) })
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })
async function prepare() {
  const config = loadConfig({ DATABASE_URL: 'postgresql://app:test@localhost/workbench_test', SYNC_ENABLED: 'false', WORKBENCH_RUNTIME_DIR: directory })
  const settings = await SettingsService.open(config), draft = settingsDraft(settings.view())
  draft.channels.forEach((channel) => { channel.enabled = channel.id === 'zentao' })
  draft.channels.find((entry) => entry.id === 'zentao')!.zentao = { baseUrl: 'https://pm.example/zentao', account: 'linjt', password: '同步测试密码' }
  await settings.save(draft)
  let run: SyncRun | null = null
  const applyZentaoSnapshot = vi.fn(async () => ({ created: 1, updated: 2 })), pendingMessages = vi.fn(async () => [])
  const store = { pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release: () => {} }) },
    latestRun: async () => run, interruptRuns: async () => {}, saveRun: async (value: SyncRun) => { run = structuredClone(value) },
    cutoff: async () => new Date().toISOString(), zentaoTrackedItems: vi.fn(async () => []), applyZentaoSnapshot, sourceCounts: async () => [], pendingMessages,
    snapshotTasks: async () => [], dailyReports: async () => [], recordedDays: async () => [], dataVersion: async () => 'fixture',
  } as unknown as Store
  const extract = vi.fn(async () => []), sync = new SyncService(store, config, { extract, close: async () => {} }, settings)
  return { settings, sync, store, extract, applyZentaoSnapshot, pendingMessages }
}
const json = (data: unknown) => new Response(JSON.stringify(data))
describe('禅道接入同步流程', () => {
  it('个人待办直接保存并计入同步结果，禅道数据不经过模型或会话采集', async () => {
    const { settings, sync, store, extract, applyZentaoSnapshot, pendingMessages } = await prepare()
    await mkdir(join(directory, 'codex'))
    await writeFile(join(directory, 'codex/session.jsonl'), '只检查文件信息，不重新读取此会话')
    const draft = settingsDraft(settings.view()), codex = draft.channels.find((entry) => entry.id === 'codex')!
    codex.enabled = true; codex.paths = [join(directory, 'codex')]
    store.sourceCounts = async () => [{ source: 'codex', count: 88 }]
    await settings.save(draft)
    const fetch = vi.fn().mockResolvedValueOnce(json({ status: 'success', token: '同步测试令牌' }))
      .mockResolvedValueOnce(json({ status: 'success', bugs: [{ id: '1', title: '待验证 Bug', status: 'resolved', assignedTo: 'linjt' }], pager: { recTotal: 1, recPerPage: 100, pageID: 1 } }))
      .mockResolvedValueOnce(json({ status: 'success', tasks: [], pager: { recTotal: 0, recPerPage: 100, pageID: 1 } }))
    vi.stubGlobal('fetch', fetch)
    try {
      await sync.start(); await sync.trigger('zentao'); await sync.waitForIdle()
      expect(await store.latestRun()).toMatchObject({ status: 'succeeded', newTasks: 1, updatedTasks: 2, newMessages: 0, activeSource: null })
      expect(applyZentaoSnapshot).toHaveBeenCalledOnce(); expect(extract).not.toHaveBeenCalled()
      expect(store.zentaoTrackedItems).toHaveBeenCalledWith('https://pm.example/zentao', 'linjt')
      expect(pendingMessages.mock.calls[0][0]).toEqual([])
      expect((await sync.snapshot()).sources.zentao).toMatchObject({ available: true, sessionCount: 1, error: null, collector: 'zentao', enabled: true })
      expect((await sync.snapshot()).sources.codex).toMatchObject({ available: true, sessionCount: 88, error: null, enabled: true })
    } finally { await sync.close() }
  })
  it('个人列表缺少已关闭 Bug 时补查已采集事项，再保存两个待办和一条完成记录', async () => {
    const { sync, store, applyZentaoSnapshot, extract } = await prepare()
    store.zentaoTrackedItems = vi.fn(async () => [{ type: 'bug', id: '3' }])
    const fetch = vi.fn().mockResolvedValueOnce(json({ status: 'success', token: '同步测试令牌' }))
      .mockResolvedValueOnce(json({ status: 'success', bugs: [1, 2].map((id) => ({ id, title: `待验证 Bug ${id}`, status: 'resolved', assignedTo: 'linjt', resolvedBy: '开发人员' })), pager: { recTotal: 2, recPerPage: 100, pageID: 1 } }))
      .mockResolvedValueOnce(json({ status: 'success', tasks: [], pager: { recTotal: 0, recPerPage: 100, pageID: 1 } }))
      .mockResolvedValueOnce(json({ status: 'success', bug: { id: 3, title: '今天已验证 Bug', status: 'closed', assignedTo: 'closed', resolvedDate: '2026-09-24 16:59:00', closedDate: '2026-10-06 14:05:25' } }))
    vi.stubGlobal('fetch', fetch)
    try {
      await sync.trigger('zentao'); await sync.waitForIdle()
      expect((await store.latestRun())?.status).toBe('succeeded')
      expect(applyZentaoSnapshot).toHaveBeenCalledWith(expect.objectContaining({ bugs: 2, tasks: 0,
        items: expect.arrayContaining([expect.objectContaining({ reference: 'BUG-3', state: 'completed', completedAt: '2026-10-06T06:05:25.000Z' })]) }))
      expect((await sync.snapshot()).sources.zentao?.sessionCount).toBe(2)
      expect(fetch.mock.calls.at(-1)?.[0]).toBe('https://pm.example/zentao/api.php/v2/bugs/3')
      expect(extract).not.toHaveBeenCalled()
    } finally { await sync.close() }
  })
  it('完成状态已保存但锁尚未释放时，新同步等待清理后启动，不误返回上轮结果', async () => {
    const { settings, sync, store } = await prepare()
    const draft = settingsDraft(settings.view()); draft.channels.forEach((channel) => { channel.enabled = false }); await settings.save(draft)
    let release!: () => void, unlocks = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = { query: async (sql: string) => {
      if (sql.includes('pg_advisory_unlock') && ++unlocks === 1) await gate
      return { rows: [{ locked: true }] }
    }, release: () => {} }
    store.pool.connect = vi.fn(async () => client) as never
    try {
      const first = await sync.trigger()
      await vi.waitFor(async () => expect((await store.latestRun())?.status).toBe('succeeded'))
      const second = sync.trigger('zentao')
      release()
      expect((await second).id).not.toBe(first.id)
      await sync.waitForIdle()
    } finally { release(); await sync.close() }
  })
  it('任一工作列表失败时不提交或清空待办，错误只影响禅道来源', async () => {
    const { sync, store, extract, applyZentaoSnapshot } = await prepare()
    const fetch = vi.fn().mockResolvedValueOnce(json({ status: 'success', token: '同步测试令牌' }))
      .mockResolvedValueOnce(json({ status: 'success', bugs: [], pager: { recTotal: 0, recPerPage: 100, pageID: 1 } }))
      .mockResolvedValueOnce(new Response('含有同步测试密码和令牌的错误', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    try {
      await sync.trigger(); await sync.waitForIdle()
      const run = await store.latestRun()
      expect(run?.status).toBe('partial_failed'); expect(run?.errors[0]).toContain('zentao：')
      expect(JSON.stringify(run)).not.toContain('同步测试密码'); expect(JSON.stringify(run)).not.toContain('同步测试令牌')
      expect(applyZentaoSnapshot).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled()
      expect((await sync.snapshot()).sources.zentao?.available).toBe(false)
    } finally { await sync.close() }
  })
  it('停用禅道后保留配置和历史数据，手动同步也不再访问禅道', async () => {
    const { settings, sync, store, applyZentaoSnapshot } = await prepare(), fetch = vi.fn()
    const draft = settingsDraft(settings.view()); draft.channels.find((entry) => entry.id === 'zentao')!.enabled = false
    await settings.save(draft); vi.stubGlobal('fetch', fetch)
    try {
      await sync.trigger(); await sync.waitForIdle()
      expect((await store.latestRun())?.status).toBe('succeeded')
      expect(fetch).not.toHaveBeenCalled(); expect(applyZentaoSnapshot).not.toHaveBeenCalled()
      expect((await sync.snapshot()).sources.zentao?.enabled).toBe(false)
      expect(settings.zentaoConnection()).not.toBeNull()
    } finally { await sync.close() }
  })
})
