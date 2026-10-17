import type { ServerResponse } from 'node:http'
import type { PoolClient } from 'pg'
import type { WorkbenchEvents, WorkbenchEventName } from '../shared/events.js'
import type { Store } from './store.js'
import type { SyncService } from './sync.js'
import { modelRouter } from './modelRouting.js'
import { redact } from './redact.js'

// 一个应用实例仅占一个 LISTEN 连接；所有标签页共享，不为每个客户端轮询数据库。
export class WorkbenchEventStream {
  private clients = new Map<ServerResponse, () => void>()
  private listener?: PoolClient
  private connecting?: Promise<void>
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private flushing = false
  private changed = false
  private progress = false
  private created = new Set<string>()
  private unsubscribers: (() => void)[]
  constructor(private store: Store, private sync: SyncService, private secrets: () => string[]) {
    this.unsubscribers = [modelRouter.subscribe((event) => {
      if (!this.clients.size) return
      const status = sync.realtimeStatus()
      if (event.from && event.to) this.publish('model:failover', { ...status, from: event.from, to: event.to })
      else this.publish('model:changed', status)
    })]
    if (sync.settings?.subscribe) this.unsubscribers.push(sync.settings.subscribe(() => {
      if (!this.clients.size) return
      this.publish('model:changed', sync.realtimeStatus())
      this.changed = true; this.schedule()
    }))
  }
  async ready() {
    if (this.stopped) throw new Error('实时事件服务正在关闭')
    if (this.connecting) return this.connecting
    if (this.listener) return
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = undefined })
    await this.connecting
  }
  private async connect() {
    const client = await this.store.pool.connect()
    const failed = () => {
      if (this.listener !== client) return
      this.listener = undefined
      client.removeAllListeners('notification'); client.removeListener('error', failed); client.removeListener('end', failed)
      client.release(true)
      // 结束 SSE 让原生 EventSource 重连，前端同时恢复低频轮询。
      for (const cleanup of [...this.clients.values()]) cleanup()
    }
    client.on('error', failed); client.on('end', failed)
    client.on('notification', (message) => {
      if (message.channel !== 'workbench_events' || !this.clients.size) return
      try {
        const event = JSON.parse(message.payload ?? '')
        if (event.kind === 'created' && typeof event.id === 'string') this.created.add(event.id)
        else if (event.kind === 'sync') this.progress = true
        else if (event.kind === 'changed') this.changed = true
        this.schedule()
      } catch { /* 不处理来自未知写入方的非契约通知。 */ }
    })
    try {
      this.listener = client
      await client.query('LISTEN workbench_events')
      if (this.stopped) failed()
    } catch (error) { failed(); throw error }
  }
  attach(response: ServerResponse, initial?: WorkbenchEvents['sync:progress']) {
    if (this.stopped) { response.end(); return }
    const cleanup = () => {
      clearInterval(heartbeat)
      this.clients.delete(response)
      response.removeListener('close', cleanup); response.removeListener('error', cleanup)
      if (!response.writableEnded) response.end()
    }
    const heartbeat = setInterval(() => {
      if (!response.write(': heartbeat\n\n')) { response.destroy(); cleanup() }
    }, 25_000)
    heartbeat.unref?.()
    this.clients.set(response, cleanup)
    response.on('close', cleanup); response.on('error', cleanup)
    response.write('retry: 3000\n\n')
    if (initial) response.write(`event: sync:progress\ndata: ${JSON.stringify(initial)}\n\n`)
  }
  publish<K extends WorkbenchEventName>(name: K, data: WorkbenchEvents[K]) {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    for (const [response, cleanup] of this.clients) {
      // 慢客户端断开后通过快照恢复，不在服务端无限缓存事件。
      if (response.destroyed || !response.write(frame)) { response.destroy(); cleanup() }
    }
  }
  private schedule() {
    if (this.timer || this.flushing || this.stopped || !this.clients.size) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 60)
    this.timer.unref?.()
  }
  private async flush() {
    this.flushing = true
    const changed = this.changed, progress = this.progress, ids = [...this.created]
    this.changed = false; this.progress = false; this.created.clear()
    try {
      if (changed) this.publish('workbench:changed', { dataVersion: await this.store.dataVersion() })
      if (progress) this.publish('sync:progress', this.sync.realtimeStatus(await this.store.latestRun()))
      if (ids.length) {
        // 提交后再核对可见性；未完成的禅道与计划待办才进入通知摘要。
        const { rows } = await this.store.pool.query(`SELECT id,reference,title,source FROM workbench.tasks
          WHERE id=ANY($1::text[]) AND deleted_at IS NULL AND completed_at IS NULL AND NOT is_personal
          AND (source='zentao' OR scheduled_plan IS NOT NULL)`, [ids])
        const secrets = this.secrets()
        if (rows.length) this.publish('tasks:created', { tasks: rows.map((row) => ({ id: row.id, source: row.source,
          reference: redact(row.reference, secrets), title: redact(row.title, secrets) })) })
      }
    } catch {
      // 数据流中断不能让前端误以为实时连接正常。
      for (const cleanup of [...this.clients.values()]) cleanup()
    } finally {
      this.flushing = false
      if (this.changed || this.progress || this.created.size) this.schedule()
    }
  }
  async close() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    for (const cleanup of [...this.clients.values()]) cleanup()
    await this.connecting?.catch(() => {})
    if (this.listener) {
      const client = this.listener; this.listener = undefined
      await client.query('UNLISTEN workbench_events').catch(() => {})
      client.removeAllListeners('notification'); client.removeAllListeners('error'); client.removeAllListeners('end')
      client.release()
    }
  }
}
