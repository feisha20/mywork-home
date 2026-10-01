import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { Config } from './config.js'
import { Store } from './store.js'
import { SyncService } from './sync.js'

const legacyTask = z.object({ id: z.uuid(), reference: z.string().max(100), source: z.literal('manual'),
  title: z.string().trim().min(1).max(300), createdAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }).nullable() })

export async function createApp(config: Config, store: Store, sync: SyncService) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return
    const origin = request.headers.origin
    let allowed = !origin
    if (origin) {
      try { const url = new URL(origin); allowed = ['http:', 'https:'].includes(url.protocol) && [request.headers.host, '127.0.0.1:5173', 'localhost:5173'].includes(url.host) }
      catch { allowed = false }
    }
    if (!allowed) {
      return reply.code(403).send({ error: '请求来源不受支持' })
    }
    if (!['GET', 'HEAD'].includes(request.method) && !request.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).send({ error: '请使用 JSON 请求' })
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500
    void reply.code(status).send({ error: status === 400 ? '请求数据无效，请检查输入内容' : status === 409 && error instanceof Error ? error.message : '请求失败，请检查服务或数据库连接后重试' })
  })
  app.get('/api/health', async (_request, reply) => {
    try { await store.pool.query('SELECT 1'); return { status: 'ok' } }
    catch { return reply.code(503).send({ status: 'unavailable' }) }
  })
  app.get('/api/workbench', () => sync.snapshot())
  app.post('/api/tasks', async (request, reply) => {
    const { title } = z.object({ title: z.string().trim().min(1).max(300) }).parse(request.body)
    return reply.code(201).send(await store.createTask(title))
  })
  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params)
    const { completed } = z.object({ completed: z.boolean() }).parse(request.body)
    const task = await store.setCompleted(id, completed)
    return task ?? reply.code(404).send({ error: '事项不存在' })
  })
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params)
    if (!await store.deleteTask(id)) return reply.code(404).send({ error: '待办不存在或已删除' })
    return { deleted: true }
  })
  app.post('/api/tasks/import', async (request) => {
    const { tasks } = z.object({ tasks: z.array(legacyTask).max(2000) }).parse(request.body)
    return store.importTasks(tasks)
  })
  app.post('/api/sync', async (_request, reply) => reply.code(202).send(await sync.trigger()))
  app.get('/api/sync/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    return await store.run(id) ?? reply.code(404).send({ error: '同步记录不存在' })
  })
  if (existsSync(config.STATIC_DIR)) {
    await app.register(fastifyStatic, { root: config.STATIC_DIR })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' })
      if (request.method !== 'GET' || !request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: '资源不存在' })
      return reply.sendFile('index.html')
    })
  }
  return app
}
