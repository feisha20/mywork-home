import type { SourceStatus, SyncRun, WorkbenchSnapshot } from '../../shared/contracts.js'
import type { ChannelConfig } from '../../shared/settings.js'
import type { SettingsService } from '../settings.js'
import type { Store } from '../store.js'
import { zentaoIdentity } from '../../shared/settings.js'
import { ZentaoError, ZentaoV2Client } from '../zentao.js'

export interface ZentaoSyncContext {
  run: SyncRun
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
      sources.zentao = { available: false, sessionCount: 0, error: reason }
      setSourceCheck(channel.id, channelSourceKey(channel), sources.zentao)
      onError(run, `zentao：${reason}`)
    }

    if (zentaoConnection && managementSettings?.enabled && this.store.management) {
      const { instance, account } = zentaoIdentity(zentaoConnection)
      try {
        const trackedIds = await this.store.management.trackedIds(instance, account)
        run.phase = 'scanning'
        await onProgress(run)
        const managementBatch = await new ZentaoV2Client(zentaoConnection).readManagement(managementSettings, trackedIds)
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
        const reason = error instanceof ZentaoError ? error.message : '管理数据读取或保存失败，本轮保留已有事项'
        await this.store.management.markFailed(instance, account, reason)
        onError(run, 'zentao：管理采集 · ' + reason)
      }
    }

    run.phase = 'scanning'
    await onProgress(run)
  }
}
