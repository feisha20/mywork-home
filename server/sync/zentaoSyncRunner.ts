import { ZentaoCollectionCache } from '../zentaoCollectionCache.js'
import { logger } from '../logger.js'
import type { SourceStatus, SyncRun, WorkbenchSnapshot } from '../../shared/contracts.js'
import type { ChannelConfig } from '../../shared/settings.js'
import type { SettingsService } from '../settings.js'
import type { Store } from '../store.js'
import { zentaoIdentity } from '../../shared/settings.js'
import { ZentaoError, ZentaoV2Client } from '../zentao.js'

export interface ZentaoSyncContext {
  run: SyncRun
  fullRefresh?: boolean
  requestBudget?: number
  trackedExecutionIds?: string[]
  channel: ChannelConfig
  sources: WorkbenchSnapshot['sources']
  isStopping: () => boolean
  onError: (run: SyncRun, message: string) => void
  onProgress: (run: SyncRun) => Promise<void>
  setSourceCheck: (id: string, key: string, status: Pick<SourceStatus, 'available' | 'error'>) => void
  channelSourceKey: (channel: ChannelConfig) => string
}

export class ZentaoSyncRunner {
  constructor(
    private readonly store: Store,
    private readonly settings?: SettingsService,
  ) {}

  async runZentaoSync(ctx: ZentaoSyncContext): Promise<void> {
    const { run, channel, sources, isStopping, onError, onProgress, setSourceCheck, channelSourceKey } = ctx
    const zentaoConnection = this.settings?.zentaoConnection()
    const managementSettings = this.settings?.zentaoManagementSettings()

    run.activeSource = 'zentao'
    await onProgress(run)
    const identity = zentaoConnection ? zentaoIdentity(zentaoConnection) : null
    const persistence = new ZentaoCollectionCache(this.store.pool)
    const cache = identity ? await persistence.load(identity.instance, identity.account) : { entries: {} }
    if (cache.retryAt && cache.retryAt > Date.now() && !ctx.fullRefresh) {
      const reason = '禅道连接处于退避等待，将于 ' + new Date(cache.retryAt).toISOString() + ' 后重试'
      sources.zentao = { available: false, sessionCount: 0, error: reason }
      onError(run, 'zentao：' + reason)
      return
    }
    let connectionFailed = false
    try {
      try {
        if (!zentaoConnection) throw new ZentaoError('请在采集源的禅道设置中填写地址、账号和密码')
        const identity = zentaoIdentity(zentaoConnection)
        const tracked = await this.store.zentaoTrackedItems(identity.instance, identity.account)
        const snapshot = await new ZentaoV2Client(zentaoConnection).readWork(tracked)
        if (isStopping()) return
        run.phase = 'saving'
        await onProgress(run)
        const counts = await this.store.applyZentaoSnapshot(snapshot)
        run.newTasks += counts.created
        run.updatedTasks += counts.updated
        sources.zentao = { available: true, sessionCount: snapshot.bugs + snapshot.tasks, error: null }
        setSourceCheck(channel.id, channelSourceKey(channel), sources.zentao)
      } catch (error) {
        const reason = error instanceof ZentaoError ? error.message : '禅道待办保存失败，本轮保留已有记录，下次同步重试'
        connectionFailed ||= error instanceof Error && error.name === 'ZentaoConnectionError'
        sources.zentao = { available: false, sessionCount: 0, error: reason }
        setSourceCheck(channel.id, channelSourceKey(channel), sources.zentao)
        onError(run, `zentao：${reason}`)
      }

      if (connectionFailed && identity && managementSettings?.enabled && this.store.management) {
        await this.store.management.markFailed(identity.instance, identity.account, '禅道连接失败，保留已有风险并等待重新核验')
      }
      if (!connectionFailed && zentaoConnection && managementSettings?.enabled && this.store.management) {
        const { instance, account } = zentaoIdentity(zentaoConnection)
        try {
          const trackedIds = await this.store.management.trackedIds(instance, account)
          run.phase = 'scanning'
          await onProgress(run)
          const managementBatch = await new ZentaoV2Client(zentaoConnection).readManagement(managementSettings, trackedIds, { cache, requestBudget: ctx.requestBudget, trackedExecutionIds: ctx.trackedExecutionIds, fullRefresh: ctx.fullRefresh, shouldStop: isStopping })
          connectionFailed = (managementBatch.collectionDiagnostics?.connectionFailures ?? 0) >= 3
          run.zentaoCollection = managementBatch.collectionDiagnostics
          logger.info({ runId: run.id, ...managementBatch.collectionDiagnostics }, '禅道管理采集请求与缓存统计')
          if (isStopping()) return
          run.phase = 'saving'
          await onProgress(run)
          const counts = await this.store.management.apply(managementBatch, managementSettings)
          run.newTasks += counts.created
          run.updatedTasks += counts.updated
          for (const issue of counts.issues) onError(run, 'zentao：管理采集 · ' + issue)
          const pending = await this.store.zentaoPendingCount(instance, account)
          sources.zentao = { ...sources.zentao!, sessionCount: pending }
        } catch (error) {
          connectionFailed ||= error instanceof Error && error.name === 'ZentaoConnectionError'
          const reason = error instanceof ZentaoError ? error.message : '管理数据读取或保存失败，本轮保留已有事项'
          await this.store.management.markFailed(instance, account, reason)
          onError(run, 'zentao：管理采集 · ' + reason)
        }
      }
    } finally {
      if (identity) {
        cache.failures = connectionFailed ? (cache.failures ?? 0) + 1 : 0
        cache.retryAt = connectionFailed ? Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(cache.failures, 6)) : 0
        await persistence.save(identity.instance, identity.account, cache)
      }
    }
    run.phase = 'scanning'
    await onProgress(run)
  }
}
