import 'dotenv/config'
import { Pool } from 'pg'
import { spawn } from 'node:child_process'

let testUrl = process.env.TEST_DATABASE_URL
let admin, database
const quote = (value) => '"' + value.replaceAll('"', '""') + '"'
try {
  if (!testUrl) {
    if (!process.env.WORKBENCH_ADMIN_DATABASE_URL || !process.env.DATABASE_URL) throw new Error('请提供临时管理员连接以创建隔离测试库，或设置 TEST_DATABASE_URL 指向名称包含 _test 的专用测试库')
    admin = new Pool({ connectionString: process.env.WORKBENCH_ADMIN_DATABASE_URL, max: 1 })
    database = `mywork_home_test_${Date.now()}`
    const url = new URL(process.env.DATABASE_URL)
    await admin.query(`CREATE DATABASE ${quote(database)} OWNER ${quote(decodeURIComponent(url.username))}`)
    url.pathname = `/${database}`; testUrl = url.toString()
  }
  if (!new URL(testUrl).pathname.includes('_test')) throw new Error('集成测试必须使用专用测试数据库')
  const env = { ...process.env, TEST_DATABASE_URL: testUrl, RUN_DATABASE_TESTS: 'true' }
  delete env.WORKBENCH_ADMIN_DATABASE_URL
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'server/integration.test.ts'], { env, stdio: 'inherit' })
    child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1))
  })
} catch { console.error('集成测试未完成：请检查隔离测试数据库和临时管理员配置。'); process.exitCode = 1 }
finally { if (admin && database) await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`); await admin?.end() }
