import { modelRouter } from './modelRouting.js'
import { modelUsage } from '../shared/modelUsage.js'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import type { SourceStatus, SyncRun, WorkbenchSnapshot } from '../shared/contracts.js'
import type { ChannelConfig } from '../shared/settings.js'
import type { Config } from './config.js'
import { extractionFailureReason, type Extractor } from './harness.js'
import { Store } from './store.js'
import { digest, isRecordDataError, listRecordFiles, readDelta, type Source, type SourceMessage } from './records.js'
import { ZcodeReader } from './zcode.js'
import { listGeminiRecordFiles, readGeminiDelta, type GeminiRecordFile } from './gemini.js'
import { redact } from './redact.js'
import { dateKey } from '../src/domain/workbench.js'
import { initialChannels, type SettingsService } from './settings.js'
import { classifyCompatibleFile, isCompatibleDatabase, listCompatibleCandidates, readCompatibleDelta, recordReaderSignature } from './compatibleRecords.js'
import type { CompatibleRecordFile } from './compatibleRecords.js'
import { ZentaoError, ZentaoV2Client } from './zentao.js'
import { SourcePaths } from './sourcePaths.js'

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
    zentao: { available: false, sessionCount: 0, error: '尚未扫描' },
    codex: { available: false, sessionCount: 0, error: '尚未扫描' },
    claude: { available: false, sessionCount: 0, error: '尚未扫描' },
    workbuddy: { available: false, sessionCount: 0, error: '尚未扫描' },
    zcode: { available: false, sessionCount: 0, error: '尚未扫描' },
    gemini: { available: false, sessionCount: 0, error: '尚未扫描' },
  }
  private fileFormats = new Map<string, { fingerprint: string; file: CompatibleRecordFile }>()
  private sourceSyncKeys = new Map<string, string>()
  private sourceChecks = new Map<string, { key: string; status: Promise<Pick<SourceStatus, 'available' | 'error'>> }>()
  private sourceCounts: Promise<{ source: Source; count: number }[]> | null = null
  private snapshotCache: { version: string; day: string; tasks: WorkbenchSnapshot['tasks']; dailyReports: WorkbenchSnapshot['dailyReports']; days: string[] } | null = null
  private unsubscribe: (() => void) | undefined
  constructor(readonly store: Store, private config: Config, private extractor: Extractor, readonly settings?: SettingsService) {
    this.unsubscribe = settings?.subscribe(() => {
      const keys = new Map<string, string>(this.currentChannels().map((channel) => [channel.id, this.sourceKey(channel)]))
      for (const [id, key] of this.sourceSyncKeys) if (keys.get(id) !== key) this.sourceSyncKeys.delete(id)
      for (const [id, check] of this.sourceChecks) if (keys.get(id) !== check.key) this.sourceChecks.delete(id)
      this.reschedule()
    })
  }
  async start() {
    // 只有取得全局锁的实例才可把上次未完成执行标为中断。
    const client = await this.store.pool.connect()
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(73921002) AS locked')
      if (rows[0].locked) { await this.store.interruptRuns(); await client.query('SELECT pg_advisory_unlock(73921002)') }
    } finally { client.release() }
    this.run = await this.store.latestRun()
    // 接入状态由目录可读性恢复，不必重新读取会话或调用模型。
    await this.sourceStatuses(this.currentChannels())
    if (this.currentConfig().SYNC_ENABLED === 'true') {
      await this.trigger()
      this.schedule()
    }
  }
  private currentConfig() { return this.settings?.runtimeConfig() ?? this.config }
  private currentChannels() { return this.settings?.channels() ?? initialChannels(this.currentConfig()) }
  private sourceKey(channel: ChannelConfig) {
    return JSON.stringify([channel.enabled, channel.collector, channel.paths, channel.mapping, channel.zentao])
  }
  private async checkSourcePaths(channel: ChannelConfig): Promise<Pick<SourceStatus, 'available' | 'error'>> {
    if (!channel.paths.length) return { available: false, error: '请在采集源设置中配置会话目录' }
    const result = this.settings ? await this.settings.checkPaths({ collector: channel.collector, paths: channel.paths })
      : await (await SourcePaths.detect()).check(channel.collector, channel.paths)
    const readable = (path: typeof result.paths[number]) => path.status === 'ready' || path.status === 'empty'
      && channel.collector !== 'zcode' && !(channel.collector === 'auto' && isCompatibleDatabase(path.path))
    return { available: result.paths.some(readable),
      error: [...new Set(result.paths.filter((path) => !readable(path)).map((path) => path.message))].join('；') || null }
  }
  private async sourceStatuses(channels: ChannelConfig[]): Promise<WorkbenchSnapshot['sources']> {
    const sources = { ...this.sources }
    const zentaoConnection = this.settings?.zentaoConnection()
    await Promise.all(channels.map(async (channel) => {
      let state = sources[channel.id] ?? { available: false, sessionCount: 0, error: '尚未扫描' }
      const key = this.sourceKey(channel)
      if (!channel.enabled || channel.collector === 'none') {
        state = { ...state, available: false, error: null }
      } else if (channel.collector === 'zentao') {
        if (!zentaoConnection) {
          state = { available: false, sessionCount: 0, error: null }
        } else if (this.sources.zentao?.error && this.sources.zentao.error !== '尚未扫描') {
          state = { ...this.sources.zentao }
        } else {
          const dbCount = typeof this.store.zentaoPendingCount === 'function'
            ? await this.store.zentaoPendingCount(zentaoConnection.baseUrl.replace(/\/+$/, ''), zentaoConnection.account).catch(() => 0)
            : 0
          const count = this.sources.zentao?.available ? this.sources.zentao.sessionCount : dbCount
          state = { available: true, sessionCount: count, error: null }
        }
      } else if (this.sourceSyncKeys.get(channel.id) !== key) {
        let check = this.sourceChecks.get(channel.id)
        if (check?.key !== key) {
          check = { key, status: this.checkSourcePaths(channel).catch(() => ({ available: false, error: '记录目录无法检查，请核对路径和访问权限' })) }
          this.sourceChecks.set(channel.id, check)
        }
        state = { ...state, ...await check.status }
      }
      sources[channel.id] = { ...state, enabled: channel.enabled, collector: channel.collector }
    }))
    this.sources = sources
    return sources
  }
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
  trigger(onlySource?: 'zentao'): Promise<SyncRun> {
    if (this.stopping) return Promise.reject(new Error('服务正在停止'))
    if (this.active && this.run) {
      if (this.run.status === 'running') return Promise.resolve(this.run)
      // 完成记录先于锁释放写入；此时的新请求等待清理结束再启动新一轮。
      return this.active.catch(() => {}).then(() => this.trigger(onlySource))
    }
    if (this.starting) return this.starting
    this.starting = this.beginTrigger(onlySource).finally(() => { this.starting = null })
    return this.starting
  }
  private async beginTrigger(onlySource?: 'zentao'): Promise<SyncRun> {
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
    this.active = this.execute(run, lock, onlySource).finally(() => { this.active = null })
    // 后台运行的错误已保存在执行记录，避免未处理的拒绝。
    void this.active.catch(() => {})
    return run
  }
  private error(run: SyncRun, message: string) { if (run.errors.length < 20) run.errors.push(redact(message, [this.config.WORKBENCH_LLM_API_KEY, this.currentConfig().WORKBENCH_LLM_API_KEY, ...this.currentConfig().sourceSecrets])) }
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
  private async execute(run: SyncRun, lock: PoolClient, onlySource?: 'zentao') {
    try {
      // 每轮固定配置快照，设置保存不会改变正在运行的采集或模型请求。
      const config = this.currentConfig()
      const channels = this.currentChannels().filter((channel) => channel.enabled && channel.collector !== 'none' && (!onlySource || channel.id === onlySource))
      const enabledSources = new Set(channels.filter((channel) => channel.collector !== 'zentao').map((channel) => channel.id))
      const cutoff = await this.store.cutoff()
      const secrets = [config.WORKBENCH_LLM_API_KEY, decodeURIComponent(new URL(config.DATABASE_URL).password), ...config.sourceSecrets]
      const zentaoConnection = this.settings?.zentaoConnection()
      const managementSettings = this.settings?.zentaoManagementSettings()
      for (const channel of channels) {
        if (this.stopping) break
        // 轮到该来源时才刷新状态，排队中的其他渠道保留已验证的连接。
        this.sourceSyncKeys.set(channel.id, this.sourceKey(channel))
        this.sources[channel.id as Source] = { available: false, sessionCount: 0, error: null }
        if (channel.collector === 'zentao') {
          run.activeSource = 'zentao'; await this.saveRunProgress(run)
          try {
            if (!zentaoConnection) throw new ZentaoError('请在采集源的禅道设置中填写地址、账号和密码')
            const tracked = await this.store.zentaoTrackedItems(zentaoConnection.baseUrl.replace(/\/+$/, ''), zentaoConnection.account)
            const snapshot = await new ZentaoV2Client(zentaoConnection).readWork(tracked)
            if (this.stopping) break
            run.phase = 'saving'; await this.saveRunProgress(run)
            const counts = await this.store.applyZentaoSnapshot(snapshot)
            run.newTasks += counts.created; run.updatedTasks += counts.updated
            this.sources.zentao = { available: true, sessionCount: snapshot.bugs + snapshot.tasks, error: null }
            this.sourceChecks.set(channel.id, { key: this.sourceKey(channel), status: Promise.resolve(this.sources.zentao) })
          } catch (error) {
            const reason = error instanceof ZentaoError ? error.message : '禅道待办保存失败，本轮保留已有记录，下次同步重试'
            this.sources.zentao = { available: false, sessionCount: 0, error: reason }
            this.sourceChecks.set(channel.id, { key: this.sourceKey(channel), status: Promise.resolve(this.sources.zentao) })
            this.error(run, `zentao：${reason}`)
          }
          if (zentaoConnection && managementSettings?.enabled && this.store.management) {
            const instance = zentaoConnection.baseUrl.replace(/\/+$/, '')
            try {
              const trackedIds = await this.store.management.trackedIds(instance, zentaoConnection.account)
              run.phase = 'scanning'; await this.saveRunProgress(run)
              const managementBatch = await new ZentaoV2Client(zentaoConnection).readManagement(managementSettings, trackedIds)
              if (this.stopping) break
              run.phase = 'saving'; await this.saveRunProgress(run)
              const counts = await this.store.management.apply(managementBatch, managementSettings)
              run.newTasks += counts.created; run.updatedTasks += counts.updated
              for (const issue of counts.issues) this.error(run, 'zentao：管理采集 · ' + issue)
              const pending = await this.store.zentaoPendingCount(instance, zentaoConnection.account)
              this.sources.zentao = { ...this.sources.zentao!, sessionCount: pending }
            } catch (error) {
              const reason = error instanceof ZentaoError ? error.message : '管理数据读取或保存失败，本轮保留已有事项'
              await this.store.management.markFailed(instance, zentaoConnection.account, reason)
              this.error(run, 'zentao：管理采集 · ' + reason)
            }
          }
          run.phase = 'scanning'; await this.saveRunProgress(run)
          continue
        }
        for (const root of channel.paths) {
          if (this.stopping) break
          const source = channel.id as Source
          let collector = channel.collector
          const universal = collector === 'auto' || collector === 'generic'
          if (collector === 'auto' && isCompatibleDatabase(root)) collector = 'zcode'
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
          let files: (GeminiRecordFile | CompatibleRecordFile)[]
          try {
            if (universal) {
              files = []
              let unsupported = 0
              for (const path of await listCompatibleCandidates(root)) {
                try {
                  const info = await stat(path), key = cursorKey(path)
                  const fingerprint = digest(`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${collector}:${JSON.stringify(channel.mapping)}`)
                  let file = this.fileFormats.get(key)?.fingerprint === fingerprint ? this.fileFormats.get(key)!.file : null
                  if (!file) {
                    const previous = await this.store.cursor(key), format = previous?.context.readerFormat as CompatibleRecordFile['format'] | undefined
                    if (previous && format && previous.context.readerMode === collector && previous.inode === String(info.ino) && previous.offset === info.size && previous.modifiedAt === Math.trunc(info.mtimeMs)
                      && previous.context.readerSignature === recordReaderSignature(format, channel.mapping)) {
                      file = { path, format, projectPath: previous.context.projectPath, parentSessionId: previous.context.parentSessionId, signature: previous.context.readerSignature }
                    } else file = await classifyCompatibleFile(path, collector as 'auto' | 'generic', channel.mapping)
                    if (file) {
                      if (this.fileFormats.size >= 10_000) this.fileFormats.clear()
                      this.fileFormats.set(key, { fingerprint, file })
                    }
                  }
                  if (file) files.push(file); else unsupported++
                } catch { unsupported++ }
              }
              if (unsupported) {
                this.sources[source].error = `${unsupported} 个文件未识别或无法读取，请在设置中检测记录或配置字段对应关系`
                this.error(run, `${channel.name}：${this.sources[source].error}`)
              }
            } else files = collector === 'gemini' ? await listGeminiRecordFiles(root)
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
            const signature = 'signature' in record ? record.signature : ''
            const fingerprint = digest(`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}${signature ? `:${signature}` : ''}`)
            if (await this.store.recordIgnored(key, fingerprint)) { run.ignoredFiles = (run.ignoredFiles ?? 0) + 1; continue }
            if (cursor && cursor.inode === String(info.ino) && cursor.offset === info.size && cursor.modifiedAt === Math.trunc(info.mtimeMs)
              && (!signature || cursor.context.readerSignature === signature)) continue
            let more = true, failed = false
            while (more && !this.stopping) {
              let delta
              try { delta = 'format' in record ? await readCompatibleDelta(record, source, cursor, cutoff, secrets, channel.mapping)
                : collector === 'gemini' ? await readGeminiDelta(record, cursor, cutoff, secrets) : await readDelta(file, collector as 'codex' | 'claude' | 'workbuddy', cursor, cutoff, secrets) }
              catch { await this.failRecord(run, source, key, fingerprint); failed = true; break }
              delta.cursor.context.readerMode = collector
              const data = mapped(delta, file)
              try { run.newMessages += await this.store.ingest(data.messages, data.cursor, 'reconcile' in delta && delta.reconcile === true) }
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
      }
      const counts = await this.store.sourceCounts()
      this.sourceCounts = Promise.resolve(counts)
      for (const entry of counts) {
        if (this.sources[entry.source]) this.sources[entry.source].sessionCount = entry.count
      }
      run.phase = 'extracting'; run.activeSource = null; await this.saveRunProgress(run)
      // 每次只读取有限消息；一页全部完成后再推进，失败的会话不会越过依赖继续抽取。
      const rootCache = new Map<string, string>(), blockedGroups = new Set<string>()
      let modelUnavailable = false

      const processGroup = async ([key, messages]: [string, SourceMessage[]]) => {
        if (blockedGroups.has(key)) return
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
            const reason = extractionFailureReason(error) ?? (error instanceof Error && /超时|校验|密钥|正在关闭/.test(error.message) ? redact(error.message, secrets) : '模型接入或抽取失败，请检查配置及套餐额度')
            await this.store.failBatch(id, reason); run.failedBatches++; this.error(run, reason)
            if (/密钥|模型接入/.test(reason)) modelUnavailable = true
            // 当前会话依赖前文；本批失败后不继续处理该会话的后续消息。
            blockedGroups.add(key); break
          }
        }
      }

      let after: { timestamp: string; id: string } | undefined
      while (!this.stopping && !modelUnavailable) {
        const page = await this.store.pendingMessages([...enabledSources], after, 500)
        if (!page.length) break
        const groups = new Map<string, SourceMessage[]>()
        for (const message of page) {
          if (!enabledSources.has(message.source)) continue
          const cacheKey = `${message.source}:${message.sessionId}`
          let root = rootCache.get(cacheKey)
          if (!root) { root = await this.store.resolveRoot(message.source, message.sessionId); rootCache.set(cacheKey, root) }
          message.rootSessionId = root
          const key = `${message.source}:${root}:${message.projectPath}`
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(message)
        }
        const entries = [...groups.entries()]
        let nextIndex = 0
        await Promise.all(Array.from({ length: Math.min(config.WORKBENCH_SYNC_CONCURRENCY, entries.length) }, async () => {
          while (nextIndex < entries.length && !this.stopping && !modelUnavailable) await processGroup(entries[nextIndex++]!)
        }))
        const last = page.at(-1)!
        after = { timestamp: last.timestamp, id: last.id }
        if (page.length < 500) break
      }
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
    const day = dateKey(new Date()), version = await this.store.dataVersion()
    if (!this.snapshotCache || this.snapshotCache.version !== version || this.snapshotCache.day !== day) {
      const [tasks, dailyReports, days] = await Promise.all([this.store.snapshotTasks(day), this.store.dailyReports(day, day), this.store.recordedDays()])
      this.snapshotCache = { version, day, tasks, dailyReports, days }
    }
    const { tasks, dailyReports, days } = this.snapshotCache
    const run = await this.store.latestRun()
    const config = this.currentConfig()
    const channels = this.currentChannels()
    const sources = await this.sourceStatuses(channels)
    const counts = await (this.sourceCounts ??= this.store.sourceCounts().catch((error) => { this.sourceCounts = null; throw error }))
    for (const { source, count } of counts) if (sources[source] && sources[source].collector !== 'zentao') sources[source] = { ...sources[source], sessionCount: count }
    const zentaoConn = this.settings?.zentaoConnection()
    if (sources.zentao && sources.zentao.available && sources.zentao.sessionCount === 0 && zentaoConn && typeof this.store.zentaoPendingCount === 'function') {
      const dbCount = await this.store.zentaoPendingCount(zentaoConn.baseUrl.replace(/\/+$/, ''), zentaoConn.account).catch(() => 0)
      if (dbCount > 0) sources.zentao.sessionCount = dbCount
    }
    return { version: 1, recordedDays: days, dataVersion: version, tasks: tasks.map((task) => ({ ...task, sourceLabel: channels.find((channel) => channel.id === task.source)?.name })), dailyReports,
      harness: { modelUsage: modelUsage(config.models ?? [{ id: 'default', label: '默认模型', name: config.WORKBENCH_LLM_MODEL }], modelRouter.status(config), config.autoSwitchModels ?? true), run, nextSyncAt: this.nextSyncAt, model: modelRouter.candidates(config)[0]?.name ?? config.WORKBENCH_LLM_MODEL, intervalMs: config.SYNC_INTERVAL_MS, autoSyncEnabled: config.SYNC_ENABLED === 'true' },
      sources, channels: this.settings?.summaries() }
  }
  async waitForIdle() { await this.starting; await this.active }
  async close() {
    this.unsubscribe?.()
    this.stopping = true; if (this.timer) clearTimeout(this.timer); this.nextSyncAt = null
    await this.starting; await this.extractor.close(); await this.active
  }
}
