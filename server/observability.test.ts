import { describe, expect, it } from 'vitest'
import pino from 'pino'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { loggerOptions } from './logger.js'
import type { Store } from './store.js'
import type { SyncService } from './sync.js'

describe('服务端日志与请求标识', () => {
  it('结构化日志隐藏密钥、授权头和数据库口令', () => {
    const lines: string[] = []
    const log = pino(loggerOptions('info'), { write(line) { lines.push(line) } })
    log.info({ apiKey: 'sk-abcdefghijklmnopqrst', password: 'plain-password', req: { headers: { authorization: 'Bearer private-token' } } }, 'probe')
    const text = lines.join('')
    expect(text).toContain('[已隐藏凭证]')
    expect(text).not.toContain('sk-abcdefghijklmnopqrst')
    expect(text).not.toContain('plain-password')
    expect(text).not.toContain('private-token')
  })

  it('健康检查失败和未处理异常记录请求标识与错误类型，响应不回显上游内容', async () => {
    const lines: string[] = []
    const store = { pool: { query: async () => { throw new Error('连接失败 password=db-secret-token') } } } as unknown as Store
    const sync = { snapshot: async () => { throw new Error('查询失败 password=snapshot-secret') } } as unknown as SyncService
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:fixture-password@localhost/test', STATIC_DIR: '/不存在的静态目录' })
    const app = await createApp(config, store, sync, undefined, undefined, undefined, undefined, { logStream: { write(line) { lines.push(String(line)) } } })
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'trace-health', authorization: 'Bearer private-token' } })
      expect(health.statusCode).toBe(503)
      expect(health.headers['x-request-id']).toBe('trace-health')
      expect(health.body).not.toContain('db-secret-token')
      const replaced = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'bad id' } })
      expect(replaced.headers['x-request-id']).not.toBe('bad id')
      const failed = await app.inject({ method: 'GET', url: '/api/workbench', headers: { 'x-request-id': 'trace-workbench' } })
      expect(failed.statusCode).toBe(500)
      expect(failed.json().error).toBe('请求失败，请检查服务或数据库连接后重试')
      expect(failed.body).not.toContain('snapshot-secret')
      const text = lines.join('')
      expect(text).toContain('trace-health')
      expect(text).toContain('数据库健康检查失败')
      expect(text).toContain('trace-workbench')
      expect(text).toContain('请求处理失败')
      expect(text).toContain('"type":"Error"')
      expect(text).not.toContain('db-secret-token')
      expect(text).not.toContain('snapshot-secret')
      expect(text).not.toContain('private-token')
      expect(text).not.toContain('fixture-password')
    } finally { await app.close() }
  })
})
