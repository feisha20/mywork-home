import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { migrate } from './migrations.js'
import { Store } from './store.js'
import { HarnessExtractor } from './harness.js'
import { SyncService } from './sync.js'
import { createApp } from './app.js'
import { DailyReportService } from './dailyReport.js'
import { DailyReportScheduler } from './dailyReportScheduler.js'
import { PeriodicReportScheduler } from './periodicReportScheduler.js'
import { SettingsService } from './settings.js'

const config = loadConfig()
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 })
pool.on('error', () => console.error('数据库连接异常，后续请求将重试'))
await migrate(pool)
const store = new Store(pool)
const settings = await SettingsService.open(config)
const sync = new SyncService(store, config, new HarnessExtractor(config), settings)
// 日报与同步使用独立模型运行目录，避免同时生成时互相覆盖提示词配置。
const reports = new DailyReportService(store, new HarnessExtractor(config, 'daily-report-harness', () => settings.runtimeConfig()))
const reportScheduler = new DailyReportScheduler(reports, settings)
const periodicScheduler = new PeriodicReportScheduler(store, settings)
const app = await createApp(config, store, sync, reports)
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  console.log('正在停止工作台，保存同步进度')
  try { await Promise.all([reports.close(), reportScheduler.close(), periodicScheduler.close(), sync.close(), app.close()]); await pool.end() }
  catch { console.error('关闭时发生异常，请检查运行日志'); process.exitCode = 1 }
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
await app.listen({ host: config.HOST, port: config.PORT })
reportScheduler.start()
periodicScheduler.start()
await sync.start()
console.log(`工作台已启动：http://${config.HOST}:${config.PORT}`)
