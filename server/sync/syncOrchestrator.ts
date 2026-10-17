import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { SourceStatus, SyncRun, WorkbenchSnapshot } from '../../shared/contracts.js'
import { modelUsage } from '../../shared/modelUsage.js'
import type { ChannelConfig } from '../../shared/settings.js'
import { dateKey } from '../../src/domain/workbench.js'
import { isCompatibleDatabase } from '../compatibleRecords.js'
import type { Config } from '../config.js'
import type { Extractor } from '../harness.js'
import { modelRouter } from '../modelRouting.js'
import { redact } from '../redact.js'
import type { Source } from '../records.js'
import { initialChannels, type SettingsService } from '../settings.js'
import { SourcePaths } from '../sourcePaths.js'
import type { Store } from '../store.js'
import { ExtractionBatcher } from './extractionBatcher.js'
import { SessionScanner } from './sessionScanner.js'
import { ZentaoSyncRunner } from './zentaoSyncRunner.js'

export class SyncOrchestrator {
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

  private sourceSyncKeys = new Map<string, string>()
  private sourceChecks = new Map<string, { key: string; status: Promise<Pick<SourceStatus, 'available' | 'error'>> }>()
  private sourceCounts: Promise<{ source: Source; count: number }[]> | null = null
  private snapshotCache: { version: string; day: string; tasks: WorkbenchSnapshot['tasks']; dailyReports: WorkbenchSnapshot['dailyReports']; days: string[] } | null = null
  private unsubscribe: (() => void) | undefined

  readonly sessionScanner: SessionScanner
  readonly extractionBatcher: ExtractionBatcher
  readonly zentaoSyncRunner: ZentaoSyncRunner

  constructor(
    readonly store: Store,
    private readonly config: Config,
    private readonly extractor: Extractor,
    readonly settings?: SettingsService,
  ) {
    this.sessionScanner = new SessionScanner(store)
    this.extractionBatcher = new ExtractionBatcher(store, extractor)
    this.zentaoSyncRunner = new ZentaoSyncRunner(store, settings)

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
      if (rows[0].locked) {
        await this.store.interruptRuns()
        await client.query('SELECT pg_advisory_unlock(73921002)')
      }
    } finally {
      client.release()
    }
    this.run = await this.store.latestRun()
    // 接入状态由目录可读性恢复，不必重新读取会话或调用模型。
    await this.sourceStatuses(this.currentChannels())
    if (this.currentConfig().SYNC_ENABLED === 'true') {
      await this.trigger()
      this.schedule()
    }
  }

  currentConfig() {
    return this.settings?.runtimeConfig() ?? this.config
  }

  currentChannels() {
    return this.settings?.channels() ?? initialChannels(this.currentConfig())
  }

  sourceKey(channel: ChannelConfig) {
    return JSON.stringify([channel.enabled, channel.collector, channel.paths, channel.mapping, channel.zentao])
  }

  private async checkSourcePaths(channel: ChannelConfig): Promise<Pick<SourceStatus, 'available' | 'error'>> {
    if (!channel.paths.length) return { available: false, error: '请在采集源设置中配置会话目录' }
    const result = this.settings ? await this.settings.checkPaths({ collector: channel.collector, paths: channel.paths })
      : await (await SourcePaths.detect()).check(channel.collector, channel.paths)
    const readable = (path: typeof result.paths[number]) => path.status === 'ready' || path.status === 'empty'
      && channel.collector !== 'zcode' && !(channel.collector === 'auto' && isCompatibleDatabase(path.path))
    return {
      available: result.paths.some(readable),
      error: [...new Set(result.paths.filter((path) => !readable(path)).map((path) => path.message))].join('；') || null,
    }
  }

  async sourceStatuses(channels: ChannelConfig[]): Promise<WorkbenchSnapshot['sources']> {
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
    this.timer = null
    this.nextSyncAt = null
    if (!this.stopping && this.currentConfig().SYNC_ENABLED === 'true') this.schedule()
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    const interval = this.currentConfig().SYNC_INTERVAL_MS
    this.nextSyncAt = new Date(Date.now() + interval).toISOString()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.trigger().catch(() => {}).finally(() => {
        if (!this.stopping && this.currentConfig().SYNC_ENABLED === 'true' && !this.timer) this.schedule()
      })
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
    try {
      ({ rows } = await lock.query('SELECT pg_try_advisory_lock(73921002) AS locked'))
    } catch (error) {
      lock.release(true)
      throw error
    }
    if (!rows[0].locked) {
      lock.release()
      const run = await this.store.latestRun()
      if (!run) throw new Error('其他实例正在启动同步，请稍后重试')
      return run
    }
    this.run = {
      id: randomUUID(),
      status: 'running',
      phase: 'scanning',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      activeSource: null,
      scannedFiles: 0,
      newMessages: 0,
      newTasks: 0,
      updatedTasks: 0,
      failedBatches: 0,
      ignoredFiles: 0,
      skippedRecords: 0,
      errors: [],
    }
    this.runSavePromise = Promise.resolve()
    try {
      await this.store.saveRun(this.run)
    } catch (error) {
      try {
        await lock.query('SELECT pg_advisory_unlock(73921002)')
      } finally {
        lock.release()
      }
      throw error
    }
    const run = this.run
    this.active = this.execute(run, lock, onlySource).finally(() => { this.active = null })
    // 后台运行的错误已保存在执行记录，避免未处理的拒绝。
    void this.active.catch(() => {})
    return run
  }

  private error(run: SyncRun, message: string) {
    if (run.errors.length < 20) {
      run.errors.push(redact(message, [this.config.WORKBENCH_LLM_API_KEY, this.currentConfig().WORKBENCH_LLM_API_KEY, ...this.currentConfig().sourceSecrets]))
    }
  }

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

      for (const channel of channels) {
        if (this.stopping) break
        // 轮到该来源时才刷新状态，排队中的其他渠道保留已验证的连接。
        this.sourceSyncKeys.set(channel.id, this.sourceKey(channel))
        this.sources[channel.id as Source] = { available: false, sessionCount: 0, error: null }

        if (channel.collector === 'zentao') {
          await this.zentaoSyncRunner.runZentaoSync({
            run,
            channel,
            sources: this.sources,
            isStopping: () => this.stopping,
            onError: (r, msg) => this.error(r, msg),
            onProgress: (r) => this.saveRunProgress(r),
            setSourceCheck: (id, key, status) => {
              this.sourceChecks.set(id, { key, status: Promise.resolve(status) })
            },
            channelSourceKey: (ch) => this.sourceKey(ch),
          })
          continue
        }

        await this.sessionScanner.scanChannel({
          run,
          channel,
          cutoff,
          secrets,
          sources: this.sources,
          isStopping: () => this.stopping,
          onError: (r, msg) => this.error(r, msg),
          onFailRecord: (r, src, f, fp) => this.failRecord(r, src, f, fp),
          onProgress: (r) => this.saveRunProgress(r),
        })
      }

      const counts = await this.store.sourceCounts()
      this.sourceCounts = Promise.resolve(counts)
      for (const entry of counts) {
        if (this.sources[entry.source]) this.sources[entry.source].sessionCount = entry.count
      }

      await this.extractionBatcher.extract({
        run,
        config,
        secrets,
        enabledSources,
        isStopping: () => this.stopping,
        onError: (r, msg) => this.error(r, msg),
        onProgress: (r) => this.saveRunProgress(r),
      })

      await this.runSavePromise
      run.status = this.stopping ? 'interrupted' : run.errors.length ? 'partial_failed' : 'succeeded'
    } catch {
      run.status = 'failed'
      this.error(run, '同步失败，请检查数据库连接；已有记录和进度已保留')
    } finally {
      run.phase = 'idle'
      run.activeSource = null
      run.finishedAt = new Date().toISOString()
      try {
        await this.store.saveRun(run)
      } finally {
        try {
          await lock.query('SELECT pg_advisory_unlock(73921002)')
        } finally {
          lock.release()
        }
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
    const channels = this.currentChannels()
    const sources = await this.sourceStatuses(channels)
    const counts = await (this.sourceCounts ??= this.store.sourceCounts().catch((error) => { this.sourceCounts = null; throw error }))
    for (const { source, count } of counts) if (sources[source] && sources[source].collector !== 'zentao') sources[source] = { ...sources[source], sessionCount: count }
    const zentaoConn = this.settings?.zentaoConnection()
    if (sources.zentao && sources.zentao.available && sources.zentao.sessionCount === 0 && zentaoConn && typeof this.store.zentaoPendingCount === 'function') {
      const dbCount = await this.store.zentaoPendingCount(zentaoConn.baseUrl.replace(/\/+$/, ''), zentaoConn.account).catch(() => 0)
      if (dbCount > 0) sources.zentao.sessionCount = dbCount
    }
    return {
      version: 1,
      recordedDays: days,
      dataVersion: version,
      tasks: tasks.map((task) => ({ ...task, sourceLabel: channels.find((channel) => channel.id === task.source)?.name })),
      dailyReports,
      harness: this.realtimeStatus(run).harness,
      sources,
      channels: this.settings?.summaries(),
    }
  }

  realtimeStatus(run: SyncRun | null = this.run) {
    const config = this.currentConfig(), modelRuntime = modelRouter.status(config)
    return {
      modelRuntime,
      harness: {
        modelUsage: modelUsage(config.models ?? [{ id: 'default', label: '默认模型', name: config.WORKBENCH_LLM_MODEL }], modelRuntime, config.autoSwitchModels ?? true),
        run,
        nextSyncAt: this.nextSyncAt,
        model: modelRouter.candidates(config)[0]?.name ?? config.WORKBENCH_LLM_MODEL,
        intervalMs: config.SYNC_INTERVAL_MS,
        autoSyncEnabled: config.SYNC_ENABLED === 'true',
      },
    }
  }

  async waitForIdle() {
    await this.starting
    await this.active
  }

  async close() {
    this.unsubscribe?.()
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.nextSyncAt = null
    await this.starting
    await this.extractor.close()
    await this.active
  }
}
