import type { Pool } from 'pg'

export type CollectionRow = Record<string, unknown>
export interface CollectionCacheEntry { signature: string; checkedAt: number; rows: CollectionRow[] }
export interface CollectionCacheData {
  entries: Record<string, CollectionCacheEntry>
  nextExecutionId?: string
  failures?: number
  retryAt?: number
}
export const emptyCollectionCache = (): CollectionCacheData => ({ entries: {} })
export interface ManagementReadOptions {
  cache?: CollectionCacheData
  requestBudget?: number
  fullRefresh?: boolean
  trackedExecutionIds?: string[]
  shouldStop?: () => boolean
}
export interface CollectionDiagnostics {
  requests: number; cacheHits: number; executions: number; monitored: number
  deferred: number; connectionFailures: number; durationMs: number; oldestAssociationCheck: string | null
}
export class ZentaoCollectionCache {
  constructor(private pool: Pool) {}
  async load(instance: string, account: string): Promise<CollectionCacheData> {
    const { rows } = await this.pool.query('SELECT data FROM workbench.zentao_collection_cache WHERE instance=$1 AND account=$2', [instance, account])
    return rows[0]?.data ?? emptyCollectionCache()
  }
  async save(instance: string, account: string, data: CollectionCacheData) {
    // 缓存不存登录响应或认证信息；限制历史关联和创建人元数据的保留数量与时间。
    const entries = Object.entries(data.entries).filter(([, entry]) => Date.now() - entry.checkedAt < 7 * 86_400_000)
      .sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, 10_000)
    await this.pool.query('INSERT INTO workbench.zentao_collection_cache(instance,account,data) VALUES($1,$2,$3) ON CONFLICT(instance,account) DO UPDATE SET data=excluded.data,updated_at=now()',
      [instance, account, JSON.stringify({ ...data, entries: Object.fromEntries(entries) })])
  }
}
