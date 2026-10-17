import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectoryCache } from './directoryCache.js'
import { listRecordFiles } from './records.js'
import { SessionScanner, type SessionScannerContext } from './sync/sessionScanner.js'
import type { Store } from './store.js'
import type { Cursor, SourceMessage } from './records.js'

const directories: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); directories.length = 0 })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'workbench-scan-')); directories.push(root); return root }
const line = (text: string) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-17T01:00:00Z', payload: { type: 'user_message', message: text } }) + '\n'

describe('会话扫描缓存', () => {
  it('目录列表复用、过期校准、子目录增删与根目录不可读时失效', async () => {
    const root = await directory(), cache = new DirectoryCache(50)
    const first = await cache.read(root)
    expect(await cache.read(root)).toBe(first)
    vi.useFakeTimers(); vi.advanceTimersByTime(51)
    expect(await cache.read(root)).not.toBe(first)
    vi.useRealTimers()
    await mkdir(join(root, 'nested'))
    expect((await cache.read(root)).map((entry) => entry.name)).toEqual(['nested'])
    await rm(join(root, 'nested'), { recursive: true })
    expect(await cache.read(root)).toEqual([])
    await rename(root, `${root}-moved`); directories.push(`${root}-moved`)
    await expect(cache.read(root)).rejects.toThrow()
    await mkdir(root); await writeFile(join(root, 'new.jsonl'), '')
    expect((await cache.read(root))[0].name).toBe('new.jsonl')
  })
  it('祖先目录时间不变时仍发现深层目录的新会话', async () => {
    const root = await directory(), child = join(root, 'year', 'month')
    await mkdir(child, { recursive: true })
    const cache = new DirectoryCache(), readDirectory = (path: string) => cache.read(path)
    expect(await listRecordFiles(root, readDirectory)).toEqual([])
    const parentTime = (await stat(root)).mtimeMs
    await mkdir(join(child, 'day'))
    const file = join(child, 'day', 'new.jsonl')
    await writeFile(file, line('深层新会话'))
    expect((await stat(root)).mtimeMs).toBe(parentTime)
    expect(await listRecordFiles(root, readDirectory)).toEqual([file])
    await rm(file)
    expect(await listRecordFiles(root, readDirectory)).toEqual([])
  })
  it.each(['codex', 'auto'] as const)('%s：跳过已完成文件的数据库查询，仍发现旧文件追加、替换和新增', async (collector) => {
    const root = await directory(), file = join(root, 'session.jsonl')
    await writeFile(file, line('第一项工作'))
    await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'))
    const cursors = new Map<string, Cursor>(), received: SourceMessage[] = []
    const store = { saveRun: vi.fn(), cursor: vi.fn(async (path) => cursors.get(path) ?? null), recordIgnored: vi.fn(async () => false),
      ingest: vi.fn(async (messages: SourceMessage[], cursor: Cursor) => { received.push(...messages); cursors.set(cursor.path, cursor); return messages.length }), clearRecordFailure: vi.fn() } as unknown as Store
    const ctx = { channel: { id: 'codex', name: 'Codex', collector, paths: [root] }, run: { scannedFiles: 0, newMessages: 0 },
      cutoff: '2000-01-01', secrets: [], sources: { codex: {} }, isStopping: () => false,
      onError: vi.fn(), onFailRecord: vi.fn(), onProgress: vi.fn() } as unknown as SessionScannerContext
    const scanner = new SessionScanner(store)
    await scanner.scanChannel(ctx)
    const queries = vi.mocked(store.cursor).mock.calls.length
    await scanner.scanChannel(ctx)
    expect(store.cursor).toHaveBeenCalledTimes(queries)
    expect(received.map((message) => message.text)).toEqual(['第一项工作'])
    const parentTime = (await stat(root)).mtimeMs
    await appendFile(file, line('追加第二项工作'))
    expect((await stat(root)).mtimeMs).toBe(parentTime)
    await scanner.scanChannel(ctx)
    expect(received.at(-1)?.text).toBe('追加第二项工作')
    await writeFile(join(root, 'replacement.jsonl'), line('替换会话'))
    await rename(join(root, 'replacement.jsonl'), file)
    await scanner.scanChannel(ctx)
    expect(received.at(-1)?.text).toBe('替换会话')
    await writeFile(join(root, 'new.jsonl'), line('新增会话'))
    await scanner.scanChannel(ctx)
    expect(received.at(-1)?.text).toBe('新增会话')
    expect(ctx.onFailRecord).not.toHaveBeenCalled()
    const beforeReset = vi.mocked(store.cursor).mock.calls.length
    scanner.clearFormatsCache()
    await scanner.scanChannel(ctx)
    expect(vi.mocked(store.cursor).mock.calls.length).toBeGreaterThan(beforeReset)
  })
  it('半行和入库失败不会被成功指纹缓存吞掉', async () => {
    const root = await directory(), file = join(root, 'session.jsonl')
    const complete = line('需要重试的工作')
    await writeFile(file, complete.slice(0, -1))
    let cursor: Cursor | null = null
    const store = { saveRun: vi.fn(), cursor: vi.fn(async () => cursor), recordIgnored: vi.fn(async () => false),
      ingest: vi.fn(async (_messages, next: Cursor) => { cursor = next; return 0 }), clearRecordFailure: vi.fn() } as unknown as Store
    const ctx = { channel: { id: 'codex', collector: 'codex', paths: [root] }, run: { scannedFiles: 0, newMessages: 0 }, cutoff: '2000-01-01', secrets: [], sources: { codex: {} },
      isStopping: () => false, onError: vi.fn(), onFailRecord: vi.fn(), onProgress: vi.fn() } as unknown as SessionScannerContext
    const scanner = new SessionScanner(store)
    await scanner.scanChannel(ctx); await scanner.scanChannel(ctx)
    expect(store.ingest).toHaveBeenCalledTimes(2)
    await appendFile(file, '\n')
    vi.mocked(store.ingest).mockRejectedValueOnce(Object.assign(new Error('模拟数据错误'), { code: '22000' }))
    await scanner.scanChannel(ctx)
    expect(ctx.onFailRecord).toHaveBeenCalledTimes(1)
    await scanner.scanChannel(ctx)
    expect(store.ingest).toHaveBeenCalledTimes(4)
    expect(vi.mocked(store.ingest).mock.calls.at(-1)?.[0][0].text).toBe('需要重试的工作')
  })
})
