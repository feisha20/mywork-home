import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import type { SyncRun, WorkbenchSnapshot } from '../shared/contracts.js'
import type { Config } from './config.js'
import type { Extractor } from './harness.js'
import { Store } from './store.js'
import { digest, isRecordDataError, listRecordFiles, readDelta, type Source, type SourceMessage } from './records.js'
import { ZcodeReader } from './zcode.js'
import { listGeminiRecordFiles, readGeminiDelta, type GeminiRecordFile } from './gemini.js'
import { redact } from './redact.js'
import { initialChannels, type SettingsService } from './settings.js'

export function messageBatches(messages: SourceMessage[], maxCharacters = 30000): SourceMessage[][] {
  const result: SourceMessage[][] = []
  let batch: SourceMessage[] = [], size = 0
  for (const message of messages) {
    const length = message.text.length
    if (batch.length && (size + length > maxCharacters || batch.length >= 30)) { result.push(batch); batch = []; size = 0 }
    // 保留来源ID；单条巨长文字取首尾，避免工具粘贴吞掉上下文窗口。
    const text = length > maxCharacters ? `${message.text.slice(0, maxCharacters / 2)}\n[中间超长内容已省略]\n${message.text.slice(-maxCharacters / 2)}` : message.text
    batch.push({ ...message, text }); size += text.length
  }
  if (batch.length) result.push(batch)
  return result
}

export class SyncService {
  private active: Promise<void> | null = null
  private starting: Promise<SyncRun> | null = null
  private run: SyncRun | null = null
  private timer: NodeJS.Timeout | null = null
  private stopping = false
  private runSavePromise: Promise<void> = Promise.resolve()
  nextSyncAt: string | null = null
  sources: WorkbenchSnapshot['sources'] = {
    codex: { available: false, sessionCount: 0, error: '尚未扫描' },
    claude: { available: false, sessionCount: 0, error: '尚未扫描' },
    workbuddy: { available: false, sessionCount: 0, error: '尚未扫描' },
    zcode: { available: false, sessionCount: 0, error: '尚未扫描' },
    gemini: { available: false, sessionCount: 0, error: '尚未扫描' },
  }
  private unsubscribe: (() => void) | undefined
  constructor(readonly store: Store, private config: Config, private extractor: Extractor, readonly settings?: SettingsService) {
    this.unsubscribe = settings?.subscribe(() => this.reschedule())
  }
  async start() {
    // 只有取得全局锁的实例才可把上次未完成执行标为中断。
    const client = await this.store.pool.connect()
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(73921002) AS locked')
      if (rows[0].locked) { await this.store.interruptRuns(); await client.query('SELECT pg_advisory_unlock(73921002)') }
    } finally { client.release() }
    this.run = await this.store.latestRun()
    if (this.currentConfig().SYNC_ENABLED === 'true') {
      await this.trigger()
      this.schedule()
    }
  }
  private currentConfig() { return this.settings?.runtimeConfig() ?? this.config }
  private reschedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.nextSyncAt = null
    if (!this.stopping && this.currentConfig().SYNC_ENABLED === 'true') this.schedule()
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    const interval = this.currentConfig().SYNC_INTERVAL_MS
    this.nextSyncAt = new Date(Date.now() + interval).toISOString()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.trigger().catch(() => {}).finally(() => { if (!this.stopping && this.currentConfig().SYNC_ENABLED === 'true' && !this.timer) this.schedule() })
    }, interval)
    this.timer.unref()
  }
  trigger(): Promise<SyncRun> {
    if (this.stopping) return Promise.reject(new Error('服务正在停止'))
    if (this.active && this.run) return Promise.resolve(this.run)
    if (this.starting) return this.starting
    this.starting = this.beginTrigger().finally(() => { this.starting = null })
    return this.starting
  }
  private async beginTrigger(): Promise<SyncRun> {
    const lock = await this.store.pool.connect()
    let rows: { locked: boolean }[]
    try { ({ rows } = await lock.query('SELECT pg_try_advisory_lock(73921002) AS locked')) }
    catch (error) { lock.release(true); throw error }
    if (!rows[0].locked) {
      lock.release()
      const run = await this.store.latestRun()
      if (!run) throw new Error('其他实例正在启动同步，请稍后重试')
      return run
    }
    this.run = { id: randomUUID(), status: 'running', phase: 'scanning', startedAt: new Date().toISOString(), finishedAt: null,
      activeSource: null, scannedFiles: 0, newMessages: 0, newTasks: 0, updatedTasks: 0, failedBatches: 0, ignoredFiles: 0, skippedRecords: 0, errors: [] }
    this.runSavePromise = Promise.resolve()
    try { await this.store.saveRun(this.run) }
    catch (error) {
      try { await lock.query('SELECT pg_advisory_unlock(73921002)') }
      finally { lock.release() }
      throw error
    }
    const run = this.run
    this.active = this.execute(run, lock).finally(() => { this.active = null })
    // 后台运行的错误已保存在执行记录，避免未处理的拒绝。
    void this.active.catch(() => {})
    return run
  }
  private error(run: SyncRun, message: string) { if (run.errors.length < 20) run.errors.push(redact(message, [this.config.WORKBENCH_LLM_API_KEY, this.currentConfig().WORKBENCH_LLM_API_KEY])) }
  private async failRecord(run: SyncRun, source: Source, file: string, fingerprint: string) {
    const attempts = await this.store.failRecord(file, source, fingerprint, run.id)
    if (attempts >= 2) run.ignoredFiles = (run.ignoredFiles ?? 0) + 1
    else this.error(run, `${source}：日志读取失败，将重试一次；再次失败后自动忽略`)
  }
  private saveRunProgress(run: SyncRun): Promise<void> {
    this.runSavePromise = this.runSavePromise
      .catch(() => {})
      .then(() => this.store.saveRun(run))
      .catch(() => {})
    return this.runSavePromise
  }
  private async execute(run: SyncRun, lock: PoolClient) {
    try {
      // 每轮固定配置快照，设置保存不会改变正在运行的采集或模型请求。
      const config = this.currentConfig()
      const channels = (this.settings?.channels() ?? initialChannels(config)).filter((channel) => channel.enabled && channel.collector !== 'none')
      const enabledSources = new Set(channels.map((channel) => channel.id))
      const cutoff = await this.store.cutoff()
      const secrets = [config.WORKBENCH_LLM_API_KEY, decodeURIComponent(new URL(config.DATABASE_URL).password)]
      for (const channel of channels) this.sources[channel.id as Source] = { available: false, sessionCount: 0, error: null }
      for (const channel of channels) for (const root of channel.paths) {
        if (this.stopping) break
        const source = channel.id as Source, collector = channel.collector
        const cursorKey = (path: string) => source.startsWith('custom-') ? `channel:${source}:${path}` : path
        const mapped = (delta: { messages: SourceMessage[]; cursor: import('./records.js').Cursor }, path: string) => ({
          messages: delta.messages.map((message) => ({ ...message, source, id: source.startsWith('custom-') ? digest(`${source}:${message.id}`) : message.id })),
          cursor: { ...delta.cursor, source, path: cursorKey(path) },
        })
        run.activeSource = source; await this.store.saveRun(run)
        if (collector === 'zcode') {
          let reader: ZcodeReader | undefined
          try {
            reader = new ZcodeReader(root)
            const sessions = reader.sessions(cutoff)
            this.sources[source].available = true
            for (const session of sessions) {
              if (this.stopping) break
              try {
                const path = reader.cursorPath(session)
                const cursor = await this.store.cursor(cursorKey(path))
                const delta = reader.readDelta(session, cursor, cutoff, secrets)
                const data = mapped(delta, path)
                run.newMessages += await this.store.ingest(data.messages, data.cursor)
                run.skippedRecords = (run.skippedRecords ?? 0) + delta.invalid
              } catch { this.error(run, `${source}：部分会话读取失败，下次同步重试`) }
            }
            run.scannedFiles++
          } catch {
            this.sources[source].error = '会话数据库不存在、无法读取或格式不兼容'
            this.error(run, `${source}：${this.sources[source].error}`)
          } finally { reader?.close() }
          continue
        }
        if (collector === 'none') continue
        let files: GeminiRecordFile[]
        try {
          files = collector === 'gemini' ? await listGeminiRecordFiles(root)
            : (await listRecordFiles(root)).map((path) => ({ path, projectPath: '', parentSessionId: null }))
          this.sources[source].available = true
        }
        catch { this.sources[source].error = '记录目录不存在或无法读取'; this.error(run, `${source}：记录目录不存在或无法读取`); continue }
        for (const record of files) {
          if (this.stopping) break
          const file = record.path
          let info
          try { info = await stat(file) }
          catch { await this.failRecord(run, source, cursorKey(file), 'unreadable'); continue }
          const key = cursorKey(file)
          let cursor = await this.store.cursor(key)
          if (!cursor && info.mtimeMs < Date.parse(cutoff)) continue
          const fingerprint = digest(`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
          if (await this.store.recordIgnored(key, fingerprint)) { run.ignoredFiles = (run.ignoredFiles ?? 0) + 1; continue }
          if (cursor && cursor.inode === String(info.ino) && cursor.offset === info.size && cursor.modifiedAt === Math.trunc(info.mtimeMs)) continue
          let more = true, failed = false
          while (more && !this.stopping) {
            let delta
            try { delta = collector === 'gemini' ? await readGeminiDelta(record, cursor, cutoff, secrets) : await readDelta(file, collector, cursor, cutoff, secrets) }
            catch { await this.failRecord(run, source, key, fingerprint); failed = true; break }
            const data = mapped(delta, file)
            try { run.newMessages += await this.store.ingest(data.messages, data.cursor) }
            catch (error) {
              if (!isRecordDataError(error)) throw error
              await this.failRecord(run, source, key, fingerprint); failed = true; break
            }
            cursor = data.cursor; more = delta.more
            if (delta.blocked) { await this.failRecord(run, source, key, fingerprint); failed = true; break }
            run.skippedRecords = (run.skippedRecords ?? 0) + delta.invalid
          }
          if (!failed && !this.stopping) await this.store.clearRecordFailure(key)
          run.scannedFiles++
          if (run.scannedFiles % 20 === 0) await this.store.saveRun(run)
        }
      }
      for (const entry of await this.store.sourceCounts()) {
        if (this.sources[entry.source]) this.sources[entry.source].sessionCount = entry.count
      }
      run.phase = 'extracting'; run.activeSource = null; await this.saveRunProgress(run)
      const groups = new Map<string, SourceMessage[]>()
      const rootCache = new Map<string, string>()
      for (const message of await this.store.pendingMessages()) {
        if (!enabledSources.has(message.source)) continue
        const cacheKey = `${message.source}:${message.sessionId}`
        let root = rootCache.get(cacheKey)
        if (!root) { root = await this.store.resolveRoot(message.source, message.sessionId); rootCache.set(cacheKey, root) }
        message.rootSessionId = root
        const key = `${message.source}:${root}:${message.projectPath}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(message)
      }
      let modelUnavailable = false
      const entries = [...groups.entries()]
      const concurrency = Math.min(config.WORKBENCH_SYNC_CONCURRENCY, entries.length)
      let nextIndex = 0

      const processGroup = async ([key, messages]: [string, SourceMessage[]]) => {
        for (const batch of messageBatches(messages)) {
          if (this.stopping || modelUnavailable) break
          const id = this.store.batchId(batch)
          if (!await this.store.startBatch(id, key, batch)) continue
          try {
            const context = await this.store.contextMessages(batch[0].source, batch[0].rootSessionId, batch[0].timestamp, batch[0].projectPath)
            const tasks = await this.store.projectTasks(batch[0].projectPath)
            run.phase = 'extracting'; run.activeSource = batch[0].source; await this.saveRunProgress(run)
            const items = await this.extractor.extract(batch, context, tasks, config)
            run.phase = 'saving'; await this.saveRunProgress(run)
            const counts = await this.store.applyExtraction(id, batch, context, items)
            run.newTasks += counts.created; run.updatedTasks += counts.updated
            await this.saveRunProgress(run)
          } catch (error) {
            // 不存储上游完整错误，避免 SDK 把提示词或请求头带入日志。
            const reason = error instanceof Error && /超时|校验|密钥|正在关闭/.test(error.message) ? redact(error.message, secrets) : '模型接入或抽取失败，请检查配置及套餐额度'
            await this.store.failBatch(id, reason); run.failedBatches++; this.error(run, reason)
            if (/密钥|模型接入/.test(reason)) modelUnavailable = true
            // 当前会话依赖前文；本批失败后不继续处理该会话的后续消息。
            break
          }
        }
      }

      const workers = Array.from({ length: concurrency }, async () => {
        while (nextIndex < entries.length && !this.stopping && !modelUnavailable) {
          const entry = entries[nextIndex++]
          if (!entry) break
          await processGroup(entry)
        }
      })
      await Promise.all(workers)
      await this.runSavePromise
      run.status = this.stopping ? 'interrupted' : run.errors.length ? 'partial_failed' : 'succeeded'
    } catch { run.status = 'failed'; this.error(run, '同步失败，请检查数据库连接；已有记录和进度已保留') }
    finally {
      run.phase = 'idle'; run.activeSource = null; run.finishedAt = new Date().toISOString()
      try { await this.store.saveRun(run) }
      finally {
        try { await lock.query('SELECT pg_advisory_unlock(73921002)') }
        finally { lock.release() }
      }
    }
  }
  async snapshot(): Promise<WorkbenchSnapshot> {
    const [tasks, dailyReports, run] = await Promise.all([this.store.tasks(), this.store.dailyReports(), this.store.latestRun()])
    const config = this.currentConfig()
    const channels = this.settings?.channels()
    const sources = { ...this.sources }
    for (const channel of channels ?? []) sources[channel.id] = {
      ...(sources[channel.id] ?? { available: false, sessionCount: 0, error: '尚未扫描' }),
      enabled: channel.enabled, collector: channel.collector,
    }
    return { version: 1, tasks: tasks.map((task) => ({ ...task, sourceLabel: channels?.find((channel) => channel.id === task.source)?.name })), dailyReports,
      harness: { run, nextSyncAt: this.nextSyncAt, model: config.WORKBENCH_LLM_MODEL, intervalMs: config.SYNC_INTERVAL_MS, autoSyncEnabled: config.SYNC_ENABLED === 'true' },
      sources, channels: this.settings?.summaries() }
  }
  async close() {
    this.unsubscribe?.()
    this.stopping = true; if (this.timer) clearTimeout(this.timer); this.nextSyncAt = null
    await this.starting; await this.extractor.close(); await this.active
  }
}
