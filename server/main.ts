import Fastify, { type FastifyInstance } from 'fastify'
import { protectDatabasePool, retryDatabaseStartup } from './database.js'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { migrate } from './migrations.js'
import { Store } from './store.js'
import { HarnessExtractor } from './harness.js'
import { SyncService } from './sync.js'
import { createApp } from './app.js'
import { DailyReportService } from './dailyReport.js'
import { PeriodicReportService } from './periodicReport.js'
import { ReportAutomation } from './reportAutomation.js'
import { ScheduledTasks } from './scheduledTasks.js'
import { SettingsService } from './settings.js'
import { loggedError, logger } from './logger.js'

async function main() {
  const config = loadConfig()
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 })
  protectDatabasePool(pool)
  const stopping = new AbortController()
  // 数据库尚未就绪时也提供明确的 503，避免启动失败造成容器不断重启。
  const readiness = Fastify()
  readiness.all('/*', async (_request, reply) => reply.code(503).header('Retry-After', '5').send({ status: 'unavailable', error: '数据库尚未就绪，工作台正在等待连接恢复' }))
  let app: FastifyInstance | undefined
  let sync: SyncService | undefined
  let reports: DailyReportService | undefined
  let periodic: PeriodicReportService | undefined
  let automation: ReportAutomation | undefined
  let closing: Promise<void> | undefined
  let started = false
  let ready = false
  const shutdown = () => closing ??= (async () => {
    logger.info('正在停止工作台，保存同步进度')
    await Promise.allSettled([reports?.close(), periodic?.close(), automation?.close(), sync?.close(), app?.close()])
    await readiness.close()
    await pool.end()
  })()
  const stop = () => {
    stopping.abort()
    if (started) void shutdown().catch((error) => { logger.error({ failure: loggedError(error) }, '关闭时发生异常'); process.exitCode = 1 })
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  try {
    await readiness.listen({ host: config.HOST, port: config.PORT })
    await retryDatabaseStartup(() => migrate(pool), stopping.signal)
    stopping.signal.throwIfAborted()
    const store = new Store(pool)
    const settings = await SettingsService.open(config)
    sync = new SyncService(store, config, new HarnessExtractor(config), settings)
    reports = new DailyReportService(store, new HarnessExtractor(config, 'daily-report-harness', () => settings.runtimeConfig()))
    periodic = new PeriodicReportService(store, new HarnessExtractor(config, 'periodic-report-harness', () => settings.runtimeConfig()))
    automation = new ReportAutomation(store, settings, reports, periodic, () => sync!.waitForIdle())
    const scheduled = new ScheduledTasks(store)
    app = await createApp(config, store, sync, reports, periodic, automation, scheduled)
    await readiness.close()
    stopping.signal.throwIfAborted()
    await app.listen({ host: config.HOST, port: config.PORT })
    started = true
    // 初始化同步锁、恢复执行记录时断连同样等待恢复，不能成为新的崩溃入口。
    await retryDatabaseStartup(() => sync!.start(), stopping.signal)
    if (!stopping.signal.aborted) { scheduled.start(); automation.start() }
    ready = true
    logger.info({ host: config.HOST, port: config.PORT }, '工作台已启动')
  } catch (error) {
    if (!stopping.signal.aborted) throw error
  } finally {
    if (!ready || stopping.signal.aborted) {
      await shutdown()
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
    }
  }
}
await main().catch((error) => { logger.error({ failure: loggedError(error) }, '工作台启动失败'); process.exitCode = 1 })
