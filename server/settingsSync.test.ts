import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { SettingsService } from './settings.js'
import { SyncService } from './sync.js'
import { settingsDraft } from '../src/domain/settings.js'
import type { Cursor, SourceMessage } from './records.js'
import type { Store } from './store.js'
import type { SyncRun } from '../shared/contracts.js'
import { EMPTY_RECORD_MAPPING } from '../shared/settings.js'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbench-channel-sync-'))
  await mkdir(join(directory, 'records'))
  const timestamp = new Date().toISOString()
  await writeFile(join(directory, 'records/session.jsonl'), [
    { type: 'session_meta', timestamp, payload: { id: 'fixture-session', cwd: '/fixture-project' } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '完善采集源配置' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

// 用内存仓库检查真实文件读取与同步流程，不连接使用者的数据库和模型。
function memoryStore() {
  const messages = new Map<string, SourceMessage>(), cursors = new Map<string, Cursor>()
  const extracted = new Set<string>()
  let run: SyncRun | null = null
  const client = { query: async () => ({ rows: [{ locked: true }] }), release: () => {} }
  const store = {
    pool: { connect: async () => client }, latestRun: async () => run, interruptRuns: async () => {},
    saveRun: async (next: SyncRun) => { run = structuredClone(next) }, cutoff: async () => new Date(Date.now() - 7 * 86400000).toISOString(),
    cursor: async (path: string) => cursors.get(path) ?? null, recordIgnored: async () => false, clearRecordFailure: async () => {},
    ingest: async (input: SourceMessage[], cursor: Cursor) => {
      let added = 0
      for (const message of input) if (!messages.has(message.id)) { messages.set(message.id, message); added++ }
      cursors.set(cursor.path, cursor); return added
    },
    sourceCounts: async () => [], pendingMessages: async () => [...messages.values()].filter((message) => !extracted.has(message.id)),
    resolveRoot: async (_source: string, session: string) => session, batchId: (batch: SourceMessage[]) => batch.map((message) => message.id).join(','),
    startBatch: async () => true, contextMessages: async () => [], projectTasks: async () => [],
    applyExtraction: async (_id: string, batch: SourceMessage[]) => { batch.forEach((message) => extracted.add(message.id)); return { created: 0, updated: 0 } },
    tasks: async () => [], dailyReports: async () => [],
  } as unknown as Store
  return { store, messages, cursors }
}
async function prepare() {
  const config = loadConfig({ DATABASE_URL: 'postgresql://app:test@localhost/workbench_test', SYNC_ENABLED: 'false', WORKBENCH_RUNTIME_DIR: directory })
  const settings = await SettingsService.open(config)
  const input = settingsDraft(settings.view()); input.channels.forEach((channel) => { channel.enabled = false })
  await settings.save(input)
  return { config, settings }
}
async function finish(sync: SyncService) {
  await vi.waitFor(async () => expect((await sync.store.latestRun())?.status).toBe('succeeded'), { interval: 10 })
}

describe('设置驱动采集', () => {
  it('新增渠道自动读取不同格式，重复同步和复制文件不重复抽取，后续追加正常采集', async () => {
    const { config, settings } = await prepare()
    const timestamp = new Date().toISOString(), path = join(directory, 'records/other.jsonl')
    const row = { sessionId: 'other-session', id: 'other-user', role: 'user', content: '其他工具的用户要求', timestamp }
    await writeFile(path, JSON.stringify(row) + '\n')
    const input = settingsDraft(settings.view())
    input.channels.push({ id: 'custom-auto', name: '其他工具', logo: '', collector: 'auto', pathMode: 'manual', paths: [join(directory, 'records')], enabled: true })
    await settings.save(input)
    const { store, messages, cursors } = memoryStore(), extract = vi.fn(async () => [])
    const sync = new SyncService(store, config, { extract, close: async () => {} }, settings)
    try {
      await sync.start(); await sync.trigger(); await finish(sync)
      expect(messages.size).toBe(2); expect(extract).toHaveBeenCalledTimes(2)
      expect([...messages.values()].every((message) => message.source === 'custom-auto')).toBe(true)
      expect([...cursors.values()].every((cursor) => !!cursor.context.readerSignature)).toBe(true)
      await writeFile(join(directory, 'records/copied.jsonl'), JSON.stringify(row) + '\n')
      await sync.trigger(); await finish(sync)
      expect(messages.size).toBe(2); expect(extract).toHaveBeenCalledTimes(2)
      await appendFile(path, JSON.stringify({ ...row, id: 'other-assistant', role: 'assistant', content: '其他工具已完成' }) + '\n')
      await sync.trigger(); await finish(sync)
      expect((await store.latestRun())?.newMessages).toBe(1); expect(extract).toHaveBeenCalledTimes(3)
    } finally { await sync.close() }
  })
  it('修改字段后重新读取未变化的文件，配置继续保存到原渠道', async () => {
    const { config, settings } = await prepare(), root = join(directory, 'other')
    await mkdir(root)
    await writeFile(join(root, 'messages.jsonl'), JSON.stringify({ id: 'one', sessionId: 'other', role: 'user', timestamp: new Date().toISOString(), content: '默认字段', detail: { text: '自定义字段' } }) + '\n')
    const input = settingsDraft(settings.view())
    input.channels.push({ id: 'custom-fields', name: '其他工具', logo: '', collector: 'auto', pathMode: 'manual', paths: [root], enabled: true })
    await settings.save(input)
    const { store, messages } = memoryStore(), extract = vi.fn(async () => [])
    const sync = new SyncService(store, config, { extract, close: async () => {} }, settings)
    try {
      await sync.start(); await sync.trigger(); await finish(sync)
      expect([...messages.values()].map((message) => message.text)).toEqual(['默认字段'])
      const next = settingsDraft(settings.view()); next.channels.at(-1)!.collector = 'generic'
      next.channels.at(-1)!.mapping = { ...EMPTY_RECORD_MAPPING, text: 'detail.text' }
      await settings.save(next)
      await sync.trigger(); await finish(sync)
      expect((await store.latestRun())?.newMessages).toBe(1)
      expect([...messages.values()].map((message) => message.text)).toEqual(['默认字段', '自定义字段'])
      await sync.trigger(); await finish(sync)
      expect(extract).toHaveBeenCalledTimes(2)
    } finally { await sync.close() }
  })
  it('不认识的记录给出采集提示，可识别文件仍继续读取', async () => {
    const { config, settings } = await prepare()
    await writeFile(join(directory, 'records/unknown.json'), JSON.stringify({ unknown: '其他格式' }))
    const input = settingsDraft(settings.view())
    input.channels.push({ id: 'custom-unknown', name: '未知工具', logo: '', collector: 'auto', pathMode: 'manual', paths: [join(directory, 'records')], enabled: true })
    await settings.save(input)
    const { store, messages } = memoryStore(), sync = new SyncService(store, config, { extract: async () => [], close: async () => {} }, settings)
    try {
      await sync.start(); await sync.trigger()
      await vi.waitFor(async () => expect((await store.latestRun())?.status).toBe('partial_failed'), { interval: 10 })
      expect(messages.size).toBe(1)
      expect((await sync.snapshot()).sources['custom-unknown'].error).toContain('1 个文件未识别')
      expect((await store.latestRun())?.errors.join(' ')).toContain('检测记录')
    } finally { await sync.close() }
  })
  it('同一路径上的两个新渠道独立去重，扫描顺序遵循设置，停用来源不再抽取', async () => {
    const { config, settings } = await prepare()
    const input = settingsDraft(settings.view())
    input.channels.unshift(
      { id: 'custom-first', name: '第一个渠道', logo: '', collector: 'codex', pathMode: 'manual', paths: [join(directory, 'records')], enabled: true },
      { id: 'custom-second', name: '第二个渠道', logo: '', collector: 'codex', pathMode: 'manual', paths: [join(directory, 'records')], enabled: true },
    )
    await settings.save(input)
    const { store, messages, cursors } = memoryStore()
    const visited: string[] = [], saveRun = store.saveRun.bind(store)
    store.saveRun = async (run) => { if (run.phase === 'scanning' && run.activeSource) visited.push(run.activeSource); await saveRun(run) }
    const extract = vi.fn(async () => [])
    const sync = new SyncService(store, config, { extract, close: async () => {} }, settings)
    try {
      await sync.start(); await sync.trigger(); await finish(sync)
      expect(visited).toEqual(['custom-first', 'custom-second'])
      expect(messages.size).toBe(2); expect(new Set([...messages.values()].map((message) => message.source))).toEqual(new Set(['custom-first', 'custom-second']))
      expect([...cursors.keys()].every((key) => key.startsWith('channel:custom-'))).toBe(true)
      expect(extract).toHaveBeenCalledTimes(2)
      await sync.trigger(); await finish(sync)
      expect(extract).toHaveBeenCalledTimes(2); expect((await store.latestRun())?.newMessages).toBe(0)
      expect((await sync.snapshot()).channels?.slice(0, 2).map((channel) => channel.id)).toEqual(['custom-first', 'custom-second'])
    } finally { await sync.close() }
  })
  it('运行中保存不会改变本轮模型，停用后保留尚未抽取消息，定时开关即时生效', async () => {
    const { config, settings } = await prepare()
    const input = settingsDraft(settings.view()), codex = input.channels.find((channel) => channel.id === 'codex')!
    codex.enabled = true; codex.paths = [join(directory, 'records')]
    input.model.name = '本轮模型'; input.model.apiKey = '本轮测试密钥'
    await settings.save(input)
    const { store, messages } = memoryStore()
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    const extract = vi.fn(async (_batch, _context, _tasks, runConfig) => {
      entered(); await gate
      expect(runConfig.WORKBENCH_LLM_MODEL).toBe('本轮模型')
      expect(runConfig.WORKBENCH_LLM_API_KEY).toBe('本轮测试密钥')
      return []
    })
    const sync = new SyncService(store, config, { extract, close: async () => {} }, settings)
    try {
      await sync.start(); await sync.trigger(); await ready
      const next = settingsDraft(settings.view()); next.model.name = '下轮模型'; next.model.apiKey = '下轮测试密钥'
      next.channels.find((channel) => channel.id === 'codex')!.enabled = false
      next.sync.enabled = true; next.sync.intervalMs = 300000
      await settings.save(next)
      expect(sync.nextSyncAt).not.toBeNull()
      release(); await finish(sync)
      const pending = { ...[...messages.values()][0], id: '未抽取消息' }; messages.set(pending.id, pending)
      await sync.trigger(); await finish(sync)
      expect(extract).toHaveBeenCalledOnce()
      expect((await store.pendingMessages()).map((message) => message.id)).toContain(pending.id)
      const snapshot = await sync.snapshot()
      expect(snapshot.harness.model).toBe('下轮模型'); expect(snapshot.sources.codex.enabled).toBe(false)
      const stopped = settingsDraft(settings.view()); stopped.sync.enabled = false
      await settings.save(stopped); expect(sync.nextSyncAt).toBeNull()
    } finally { release(); await sync.close() }
  })
})
