import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { HarnessExtractor } from './harness.js'
import { Store } from './store.js'
import { SettingsService } from './settings.js'

// 旧事项只改写简介，不重置抽取批次；原文备份可用于人工复核。
const config = (await SettingsService.open(loadConfig())).runtimeConfig()
const pool = new Pool({ connectionString: config.DATABASE_URL })
const store = new Store(pool)
const extractor = new HarnessExtractor(config)
const lock = await pool.connect()
try {
  const result = await lock.query('SELECT pg_try_advisory_lock(73921002) AS locked')
  if (!result.rows[0].locked) throw new Error('同步正在运行，请等待结束或暂停服务后整理')
  const tasks = (await store.tasks()).filter((task) => !['manual', 'zentao'].includes(task.source) && task.statusOrigin !== 'manual')
  await mkdir(config.WORKBENCH_RUNTIME_DIR, { recursive: true, mode: 0o700 })
  const backup = join(config.WORKBENCH_RUNTIME_DIR, `summary-titles-${Date.now()}.json`)
  await writeFile(backup, JSON.stringify(tasks.map(({ id, title }) => ({ id, title })), null, 2), { mode: 0o600 })
  let updated = 0
  for (let offset = 0; offset < tasks.length; offset += 5) {
    const batch = tasks.slice(offset, offset + 5)
    const summaries = await extractor.summarize(batch)
    updated += await store.applySummaries(batch, summaries)
    console.log(`已整理 ${Math.min(offset + batch.length, tasks.length)}/${tasks.length} 项工作简介`)
  }
  console.log(`整理完成：更新 ${updated} 项简介，状态、日期、来源证据与读取进度均保留。`)
} catch (error) {
  console.error(error instanceof Error && /同步正在运行|校验|超时/.test(error.message) ? error.message : '工作简介整理失败；已保存的简介与原文备份保留，可再次运行。')
  process.exitCode = 1
} finally {
  await extractor.close()
  try { await lock.query('SELECT pg_advisory_unlock(73921002)') }
  finally { lock.release(); await pool.end() }
}
