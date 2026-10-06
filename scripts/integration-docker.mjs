import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

// 只创建并清理本次生成的隔离库和角色，不读取管理员密码或业务数据库。
const container = process.env.WORKBENCH_TEST_POSTGRES_CONTAINER ?? 'postgres18'
const name = `workbench_test_${Date.now()}_${randomBytes(3).toString('hex')}`
const password = randomBytes(24).toString('hex')
const run = (cmd, args, input, env = process.env, inherit = false) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { env, stdio: inherit ? 'inherit' : ['pipe','ignore','pipe'] })
  if (!inherit) { child.stdin.end(input); child.stderr.resume() }
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('隔离数据库测试命令执行失败')))
})
const sql = (body) => run('docker', ['exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], body)
try {
  await sql(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}';\nCREATE DATABASE "${name}" OWNER "${name}";\n`)
  const url = new URL(`postgresql://127.0.0.1:${process.env.WORKBENCH_TEST_POSTGRES_PORT ?? '5432'}/${name}`)
  url.username = name; url.password = password
  const env = { ...process.env, TEST_DATABASE_URL: url.toString(), RUN_DATABASE_TESTS: 'true' }
  delete env.WORKBENCH_ADMIN_DATABASE_URL
  await run(process.execPath, ['node_modules/vitest/vitest.mjs','run','server/integration.test.ts'], undefined, env, true)
} catch { console.error('本机隔离数据库测试未完成，请检查测试输出与 PostgreSQL 容器；业务数据库未参与测试。'); process.exitCode = 1 }
finally {
  // 即使初始化中途失败也只尝试删除本次唯一名称，不影响任何已有库或角色。
  try { await sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);\nDROP ROLE IF EXISTS "${name}";\n`) }
  catch { console.error(`请手动清理本次隔离测试库及角色：${name}`); process.exitCode = 1 }
}
