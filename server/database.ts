import type { Pool, PoolClient } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { loggedError, logger } from './logger.js'

const failures = new WeakMap<PoolClient, Error | null>()
// 借出的连接不会由 pg-pool 的空闲连接监听器保护；锁连接也必须处理异步 error。
export function guardDatabaseClient(client: PoolClient) {
  if (!failures.has(client)) {
    failures.set(client, null)
    client.on('error', (error: Error) => {
      failures.set(client, error)
      logger.warn({ failure: loggedError(error) }, '数据库连接中断，将销毁失效连接并在后续请求重连')
    })
  }
  return client
}
export async function acquireDatabaseClient(pool: Pool) { return guardDatabaseClient(await pool.connect()) }
export function databaseClientError(client: PoolClient) { return failures.get(client) ?? null }
export function releaseDatabaseClient(client: PoolClient, destroy = false) { client.release(destroy || !!failures.get(client)) }
export function protectDatabasePool(pool: Pool) {
  pool.on('connect', guardDatabaseClient)
  pool.on('error', (error) => logger.warn({ failure: loggedError(error) }, '数据库空闲连接异常，后续请求将重连'))
}
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300'].includes(code)
    || code.startsWith('08') || /Connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(error.message)
}
export async function retryDatabaseStartup(action: () => Promise<void>, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, abort) => delay(ms, undefined, { signal: abort })) {
  let attempt = 0
  while (!signal.aborted) {
    try { await action(); return }
    catch (error) {
      if (!isDatabaseUnavailable(error)) throw error
      const retryMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5))
      logger.warn({ failure: loggedError(error), retryMs }, '数据库暂不可用，工作台等待连接恢复')
      await wait(retryMs, signal)
    }
  }
  signal.throwIfAborted()
}
