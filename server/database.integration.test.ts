import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireDatabaseClient, databaseClientError, protectDatabasePool, releaseDatabaseClient } from './database.js'

describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true').sequential('数据库真实断连与启动容错', () => {
  let pool: Pool, writer: Pool
  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.includes('_test')) throw new Error('仅允许使用隔离测试数据库')
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
    writer = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
    protectDatabasePool(pool); protectDatabasePool(writer)
  })
  afterAll(async () => { await pool?.end(); await writer?.end() })
  it('真实借出连接被数据库终止后不会崩溃，丢弃坏连接后可继续查询', async () => {
    const client = await acquireDatabaseClient(pool)
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
    const failed = once(client, 'error')
    await writer.query('SELECT pg_terminate_backend($1)', [rows[0].pid])
    await failed
    expect(databaseClientError(client)).toBeInstanceOf(Error)
    releaseDatabaseClient(client)
    expect((await pool.query('SELECT 1 AS recovered')).rows[0].recovered).toBe(1)
  })
  it('数据库启动连接持续失败时，真实服务进程保持存活、返回503且可正常停止', async () => {
    const reserve = createServer()
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
    const port = (reserve.address() as { port: number }).port
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    // 保留一个始终拒绝协议连接的本地端口，不连接任何业务数据库。
    const unavailable = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => unavailable.listen(0, '127.0.0.1', resolve))
    const databasePort = (unavailable.address() as { port: number }).port
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
      env: { ...process.env, DATABASE_URL: `postgresql://fixture:fixture-password@127.0.0.1:${databasePort}/workbench_test_unavailable`,
        HOST: '127.0.0.1', PORT: String(port), SYNC_ENABLED: 'false', LOG_LEVEL: 'silent', WORKBENCH_LLM_API_KEY: '' },
      stdio: 'ignore',
    })
    const exited = once(child, 'exit')
    try {
      let response: Response | undefined
      for (let i = 0; i < 80; i++) {
        try { response = await fetch(`http://127.0.0.1:${port}/api/health`); break } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
      }
      expect(response?.status).toBe(503)
      expect(response?.headers.get('retry-after')).toBe('5')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(child.exitCode).toBeNull()
      child.kill('SIGTERM')
      expect((await exited)[0]).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await new Promise<void>((resolve) => unavailable.close(() => resolve()))
    }
  }, 12_000)
})
