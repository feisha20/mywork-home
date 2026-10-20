import { EventEmitter } from 'node:events'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { acquireDatabaseClient, releaseDatabaseClient, retryDatabaseStartup } from './database.js'
import { withTransaction } from './repositories/db.js'

function fixture() {
  const client = Object.assign(new EventEmitter(), { query: vi.fn(async (_sql: string) => ({})), release: vi.fn() })
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { client, pool }
}
describe('数据库断连与恢复', () => {
  it('借出的同步锁连接异步断开不会触发未处理事件，归还时销毁连接', async () => {
    const { client, pool } = fixture()
    await acquireDatabaseClient(pool); await acquireDatabaseClient(pool)
    expect(client.listenerCount('error')).toBe(1)
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
    releaseDatabaseClient(client as unknown as PoolClient)
    expect(client.release).toHaveBeenCalledWith(true)
  })
  it('事务断连后回滚也失败时仍保留第一次错误，并销毁连接', async () => {
    const { client, pool } = fixture(), original = new Error('原始连接错误')
    client.query.mockImplementation(async (sql) => { if (sql === 'ROLLBACK') throw new Error('连接已断开'); return {} })
    await expect(withTransaction(pool, async () => { throw original })).rejects.toBe(original)
    expect(client.release).toHaveBeenCalledWith(true)
  })
  it('成功事务正常归还连接', async () => {
    const { client, pool } = fixture()
    await expect(withTransaction(pool, async () => '完成')).resolves.toBe('完成')
    expect(client.release).toHaveBeenCalledWith(false)
  })
  it('启动时连接拒绝按指数退避重试，恢复后结束等待，最长间隔30秒', async () => {
    const action = vi.fn().mockRejectedValue(Object.assign(new Error('连接拒绝'), { code: 'ECONNREFUSED' }))
    const waits: number[] = []
    const wait = vi.fn(async (ms: number) => { waits.push(ms); if (waits.length === 8) action.mockResolvedValue(undefined) })
    await retryDatabaseStartup(action, new AbortController().signal, wait)
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(action).toHaveBeenCalledTimes(9)
  })
  it('SQL结构错误立即失败，停止信号可以中断连接恢复等待', async () => {
    const sqlError = Object.assign(new Error('语法错误'), { code: '42601' }), wait = vi.fn()
    await expect(retryDatabaseStartup(async () => { throw sqlError }, new AbortController().signal, wait)).rejects.toBe(sqlError)
    expect(wait).not.toHaveBeenCalled()
    const stopping = new AbortController()
    await expect(retryDatabaseStartup(async () => { throw Object.assign(new Error('断连'), { code: 'ECONNRESET' }) }, stopping.signal,
      async () => { stopping.abort(new Error('停止等待')) })).rejects.toThrow('停止等待')
  })
})
