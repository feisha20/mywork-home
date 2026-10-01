import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import type { SyncRun, WorkbenchSnapshot } from '../shared/contracts.js'
import type { Config } from './config.js'
import type { Extractor } from './harness.js'
import { Store } from './store.js'
import { listRecordFiles, readDelta, type Source, type SourceMessage } from './records.js'
import { redact } from './redact.js'

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
  nextSyncAt: string | null = null
  sources: WorkbenchSnapshot['sources'] = {
    codex: { available: false, sessionCount: 0, error: '尚未扫描' },
    claude: { available: false, sessionCount: 0, error: '尚未扫描' },
  }
  constructor(readonly store: Store, private config: Config, private extractor: Extractor) {}
  async start() {
    // 只有取得全局锁的实例才可把上次未完成执行标为中断。
    const client = await this.store.pool.connect()
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(73921002) AS locked')
      if (rows[0].locked) { await this.store.interruptRuns(); await client.query('SELECT pg_advisory_unlock(73921002)') }
    } finally { client.release() }
    this.run = await this.store.latestRun()
    if (this.config.SYNC_ENABLED === 'true') {
      await this.trigger()
      this.schedule()
    }
  }
  private schedule() {
    this.nextSyncAt = new Date(Date.now() + this.config.SYNC_INTERVAL_MS).toISOString()
    this.timer = setTimeout(() => {
      void this.trigger().catch(() => {}).finally(() => { if (!this.stopping) this.schedule() })
    }, this.config.SYNC_INTERVAL_MS)
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
      scannedFiles: 0, newMessages: 0, newTasks: 0, updatedTasks: 0, failedBatches: 0, errors: [] }
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
  private error(run: SyncRun, message: string) { if (run.errors.length < 20) run.errors.push(redact(message, [this.config.WORKBENCH_LLM_API_KEY])) }
  private async execute(run: SyncRun, lock: PoolClient) {
    try {
      const cutoff = await this.store.cutoff()
      const roots: [Source, string][] = [['codex', this.config.CODEX_SESSIONS_DIR], ['codex', this.config.CODEX_ARCHIVE_DIR], ['claude', this.config.CLAUDE_PROJECTS_DIR]]
      const secrets = [this.config.WORKBENCH_LLM_API_KEY, decodeURIComponent(new URL(this.config.DATABASE_URL).password)]
      for (const source of ['codex', 'claude'] as const) this.sources[source] = { available: false, sessionCount: 0, error: null }
      for (const [source, root] of roots) {
        if (this.stopping) break
        let files: string[]
        try { files = await listRecordFiles(root); this.sources[source].available = true }
        catch { this.sources[source].error = '记录目录不存在或无法读取'; this.error(run, `${source}：记录目录不存在或无法读取`); continue }
        for (const file of files) {
          if (this.stopping) break
          try {
            const info = await stat(file)
            let cursor = await this.store.cursor(file)
            if (!cursor && info.mtimeMs < Date.parse(cutoff)) continue
            if (cursor && cursor.inode === String(info.ino) && cursor.offset === info.size && cursor.modifiedAt === Math.trunc(info.mtimeMs)) continue
            let more = true
            while (more && !this.stopping) {
              const delta = await readDelta(file, source, cursor, cutoff, secrets)
              run.newMessages += await this.store.ingest(delta.messages, delta.cursor)
              cursor = delta.cursor; more = delta.more
              if (delta.invalid) this.error(run, `${source}：跳过 ${delta.invalid} 条损坏或超大日志记录`)
            }
            run.scannedFiles++
            if (run.scannedFiles % 20 === 0) await this.store.saveRun(run)
          } catch { this.error(run, `${source}：部分记录读取失败，下次同步重试`) }
        }
      }
      for (const entry of await this.store.sourceCounts()) this.sources[entry.source].sessionCount = entry.count
      run.phase = 'extracting'; await this.store.saveRun(run)
      const groups = new Map<string, SourceMessage[]>()
      const rootCache = new Map<string, string>()
      for (const message of await this.store.pendingMessages()) {
        const cacheKey = `${message.source}:${message.sessionId}`
        let root = rootCache.get(cacheKey)
        if (!root) { root = await this.store.resolveRoot(message.source, message.sessionId); rootCache.set(cacheKey, root) }
        message.rootSessionId = root
        const key = `${message.source}:${root}:${message.projectPath}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(message)
      }
      let modelUnavailable = false
      for (const [key, messages] of groups) {
        if (this.stopping || modelUnavailable) break
        for (const batch of messageBatches(messages)) {
          if (this.stopping) break
          const id = this.store.batchId(batch)
          await this.store.startBatch(id, key, batch)
          try {
            const context = await this.store.contextMessages(batch[0].source, batch[0].rootSessionId, batch[0].timestamp, batch[0].projectPath)
            const tasks = await this.store.projectTasks(batch[0].projectPath)
            run.phase = 'extracting'; await this.store.saveRun(run)
            const items = await this.extractor.extract(batch, context, tasks)
            run.phase = 'saving'; await this.store.saveRun(run)
            const counts = await this.store.applyExtraction(id, batch, context, items)
            run.newTasks += counts.created; run.updatedTasks += counts.updated
            await this.store.saveRun(run)
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
      run.status = this.stopping ? 'interrupted' : run.errors.length ? 'partial_failed' : 'succeeded'
    } catch { run.status = 'failed'; this.error(run, '同步失败，请检查数据库连接；已有记录和进度已保留') }
    finally {
      run.phase = 'idle'; run.finishedAt = new Date().toISOString()
      try { await this.store.saveRun(run) }
      finally {
        try { await lock.query('SELECT pg_advisory_unlock(73921002)') }
        finally { lock.release() }
      }
    }
  }
  async snapshot(): Promise<WorkbenchSnapshot> {
    return { version: 1, tasks: await this.store.tasks(), harness: { run: await this.store.latestRun(), nextSyncAt: this.nextSyncAt, model: this.config.WORKBENCH_LLM_MODEL }, sources: this.sources }
  }
  async close() {
    this.stopping = true; if (this.timer) clearTimeout(this.timer); this.nextSyncAt = null
    await this.starting; await this.extractor.close(); await this.active
  }
}
