import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { migrate } from './migrations.js'
import { Store } from './store.js'
import { SyncService } from './sync.js'
import { DailyReportService } from './dailyReport.js'
import { ModelConnectionError, modelRouter } from './modelRouting.js'
import { ScheduledTasks } from './scheduledTasks.js'

const enabled = process.env.RUN_DATABASE_TESTS === 'true'
describe.skipIf(!enabled).sequential('SSE 隔离数据库与真实 HTTP 流', () => {
  let pool: Pool, writer: Pool, app: FastifyInstance, address: string
  let controller: AbortController, pumping: Promise<void>
  const frames: { event: string; data: any }[] = []
  const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://app:test@localhost/workbench_test', SYNC_ENABLED: 'false', STATIC_DIR: '/不存在的静态目录' })
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.includes('_test')) throw new Error('禁止使用业务数据库运行测试')
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 })
    writer = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
    await migrate(pool)
    const store = new Store(pool)
    const sync = new SyncService(store, config, { async extract() { return [] }, async close() {} })
    const reports = new DailyReportService(store, { async generateDailyReport() { return [] }, async close() {} })
    app = await createApp(config, store, sync, reports)
    address = await app.listen({ port: 0, host: '127.0.0.1' })
    controller = new AbortController()
    const response = await fetch(`${address}/api/events`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('cache-control')).toContain('no-store')
    pumping = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1]
            if (event && data) frames.push({ event, data: JSON.parse(data) })
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error }
      finally { reader.releaseLock() }
    })()
    await vi.waitFor(() => expect(frames.some((frame) => frame.event === 'sync:progress')).toBe(true))
  })
  afterAll(async () => {
    controller?.abort(); await pumping?.catch(() => {})
    await app?.close(); await writer?.end(); await pool?.end()
  })
  const insert = async (id: string, title: string, personal = false) => writer.query(`INSERT INTO workbench.tasks
    (id,reference,source,title,created_at,is_personal) VALUES($1,'ZT-SSE','zentao',$2,now(),$3)`, [id, title, personal])
  it('拒绝跨源订阅', async () => {
    const response = await fetch(`${address}/api/events`, { headers: { Origin: 'https://outside.example' } })
    expect(response.status).toBe(403)
  })
  it('另一数据库连接写入后推送新待办与版本，回滚与私人事项不发新增提醒', async () => {
    const id = randomUUID()
    await insert(id, '跨实例新增 SSE 待办')
    await vi.waitFor(() => expect(frames.some((frame) => frame.event === 'tasks:created' && frame.data.tasks.some((task: { id: string }) => task.id === id))).toBe(true))
    expect(frames.some((frame) => frame.event === 'workbench:changed' && typeof frame.data.dataVersion === 'string')).toBe(true)
    const created = frames.find((frame) => frame.event === 'tasks:created' && frame.data.tasks.some((task: { id: string }) => task.id === id))!
    expect(Object.keys(created.data.tasks[0]).sort()).toEqual(['id', 'reference', 'source', 'title'])
    const rolledBack = randomUUID(), personal = randomUUID(), client = await writer.connect()
    try {
      await client.query('BEGIN')
      await client.query("INSERT INTO workbench.tasks(id,reference,source,title,created_at) VALUES($1,'ZT-ROLLBACK','zentao','不应发出提醒',now())", [rolledBack])
      await client.query('ROLLBACK')
    } finally { client.release() }
    await insert(personal, '私人待办不应进入事件摘要', true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const taskIds = frames.filter((frame) => frame.event === 'tasks:created').flatMap((frame) => frame.data.tasks.map((task: { id: string }) => task.id))
    expect(taskIds).not.toContain(rolledBack); expect(taskIds).not.toContain(personal)
  })
  it('计划任务生成后立即推送，重复补齐不重复新增', async () => {
    const scheduler = new ScheduledTasks(new Store(writer))
    const plan = await scheduler.save({ title: 'SSE 计划提醒', frequency: 'daily', time: '09:00', weekday: 1, day: 1, month: 1, quarterMonth: 1,
      startDate: '2090-01-01', endDate: null, enabled: true, isPersonal: false }, undefined, new Date('2090-01-01T00:00:00+08:00'))
    try {
      await scheduler.generateDue(new Date('2090-01-01T09:01:00+08:00'))
      await vi.waitFor(() => expect(frames.some((frame) => frame.event === 'tasks:created' && frame.data.tasks.some((task: { title: string }) => task.title === 'SSE 计划提醒'))).toBe(true))
      const count = frames.filter((frame) => frame.event === 'tasks:created').length
      await scheduler.generateDue(new Date('2090-01-01T09:01:00+08:00'))
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(frames.filter((frame) => frame.event === 'tasks:created')).toHaveLength(count)
    } finally { if (plan) await scheduler.remove(plan.id); await scheduler.close() }
  })
  it('备用模型接管即时推送，事件中没有模型密钥与连接地址', async () => {
    const models = [{ id: 'sse-primary', label: '主模型', enabled: true, baseUrl: 'https://primary.example/v1', name: 'primary', apiKey: 'primary-test-key' },
      { id: 'sse-backup', label: '备用模型', enabled: true, baseUrl: 'https://backup.example/v1', name: 'backup', apiKey: 'backup-test-key' }]
    await modelRouter.run({ ...config, models, autoSwitchModels: true }, 3000, async (candidate) => {
      if (candidate.WORKBENCH_LLM_MODEL === 'primary') throw new ModelConnectionError('模拟主模型失败')
      return '模拟成功'
    })
    await vi.waitFor(() => expect(frames.some((frame) => frame.event === 'model:failover' && frame.data.to === 'sse-backup')).toBe(true))
    const text = JSON.stringify(frames.filter((frame) => frame.event === 'model:failover'))
    expect(text).not.toMatch(/primary-test-key|backup-test-key|https:\/\//)
  })
  it('保留 SSE 连接时也能正常关闭服务并释放 LISTEN 连接', async () => {
    await app.close()
    await pumping
    const { rows } = await writer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN workbench_events' AND state='idle'")
    expect(rows[0].count).toBe(0)
  })
})
