import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { HarnessExtractor } from './harness.js'
import type { SourceMessage } from './records.js'

const enabled = process.env.RUN_HARNESS_TESTS === 'true'
let server: Server | undefined, runtime: string | undefined, extractor: HarnessExtractor | undefined
afterEach(async () => { await extractor?.close(); await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); if (runtime) await rm(runtime, { recursive: true, force: true }); server = undefined; extractor = undefined })
describe.skipIf(!enabled)('真实Harness与本地模型请求桩', () => {
  it('使用固定SDK发出兼容流式请求，无执行工具、无数据库口令', async () => {
    const requests: { url: string; body: any; authorization?: string }[] = []
    const message: SourceMessage = { id: 'fixture-evidence', source: 'codex', sessionId: 'fixture', rootSessionId: 'fixture', projectPath: '/fixture', role: 'assistant', timestamp: new Date().toISOString(), text: '已完成接口测试。password=fixture-password-123' }
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      requests.push({ url: request.url!, body, authorization: request.headers.authorization })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const content = JSON.stringify({ items: [{ title: '完成接口测试', status: 'completed', evidenceIds: [message.id] }] })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    runtime = await mkdtemp(join(tmpdir(), 'workbench-harness-'))
    extractor = new HarnessExtractor(loadConfig({ DATABASE_URL: 'postgresql://app:database-secret@localhost/test', WORKBENCH_LLM_API_KEY: 'fixture-api-key', WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${address.port}/api/coding/v3`, WORKBENCH_RUNTIME_DIR: runtime, WORKBENCH_BATCH_TIMEOUT_MS: '30000' }))
    const result = await extractor.extract([message], [], [])
    expect(result[0].status).toBe('completed')
    const req = requests.find((entry) => entry.body.messages?.some((row: any) => row.content?.includes('newMessages')))!
    expect(req.url).toBe('/api/coding/v3/chat/completions')
    expect(req.body.model).toBe('glm-5.3-flash'); expect(req.body.reasoning_effort).toBe('low'); expect(req.body.max_tokens).toBe(8192)
    expect(req.body.tools?.length ?? 0).toBe(0); expect(req.body.store).toBeUndefined()
    expect(req.body.messages.some((row: any) => row.role === 'developer')).toBe(false)
    expect(req.authorization).toBe('Bearer fixture-api-key')
    expect(JSON.stringify(req.body)).not.toContain('database-secret'); expect(JSON.stringify(req.body)).not.toContain('fixture-password-123')
  }, 60000)
})
