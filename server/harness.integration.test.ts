import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { HarnessExtractor } from './harness.js'
import type { SourceMessage } from './records.js'
import { aggregatePeriodData } from '../src/domain/periodicReport.js'
import type { Task } from '../src/domain/workbench.js'

const enabled = process.env.RUN_HARNESS_TESTS === 'true'
let server: Server | undefined, runtime: string | undefined, extractor: HarnessExtractor | undefined, reportExtractor: HarnessExtractor | undefined
afterEach(async () => { await Promise.all([extractor?.close(), reportExtractor?.close()]); await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); if (runtime) await rm(runtime, { recursive: true, force: true }); server = undefined; extractor = undefined; reportExtractor = undefined })
async function listenFixtureServer(fixture: Server) {
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', () => { fixture.off('error', reject); resolve() })
  })
}
describe.skipIf(!enabled)('真实Harness与本地模型请求桩', () => {
  it('复杂月报遗漏素材时给出精确别名并修复，不把原始日志或密钥发给模型', async () => {
    const requests: any[] = []
    const records = Array.from({ length: 75 }, (_, index) => ({ text: `合成成果${index + 1}`, taskIds: [`task-${index}`] }))
    const data = aggregatePeriodData('2026-10-01', '2026-10-31', [{ day: '2026-10-01', generatedAt: '2026-10-01T00:00:00Z', revision: 1, recordCount: 75, recordVersions: {}, items: records }], [])
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      requests.push(JSON.parse(raw))
      const result = { achievements: [{ topic: '合成项目', outcomes: ['完成合成月报校验'], sourceIds: Array.from({ length: requests.length === 1 ? 74 : 75 }, (_, index) => `R${index + 1}`) }], omittedSourceIds: [], inProgress: [], nextPlan: [] }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'monthly-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'monthly-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await listenFixtureServer(server)
    runtime = await mkdtemp(join(tmpdir(), 'workbench-monthly-'))
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:database-secret@localhost/test', WORKBENCH_RUNTIME_DIR: runtime, WORKBENCH_LLM_API_KEY: 'monthly-fixture-key', WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })
    extractor = new HarnessExtractor(config)
    const sections = await extractor.generatePeriodicReport('monthly', data)
    expect(sections[0].items).toEqual(['【合成项目】完成合成月报校验'])
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('周期报告遗漏成果素材：缺少 1 条，请补齐 R75')
    expect(JSON.stringify(requests)).not.toContain('database-secret')
    expect(JSON.stringify(requests)).not.toContain('monthly-fixture-key')
  }, 60000)
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages', 'gemini_native'] as const)('%s 原生约束通过本地 HTTP 桩完成证据还原', async (format) => {
    const requests: any[] = []
    const output = { items: [{ taskId: null, title: '完成结构化抽取验证', status: 'completed', isPersonal: false, evidenceIds: ['M1'] }] }
    const text = JSON.stringify(output)
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) })
      const result = format === 'gemini_native' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
        : format === 'anthropic-messages' ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'workbench_extract', input: output }] }
          : format === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
            : { choices: [{ finish_reason: 'stop', message: { content: text } }] }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
    })
    await listenFixtureServer(server)
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:database-secret@localhost/test', WORKBENCH_LLM_API_FORMAT: format,
      WORKBENCH_LLM_API_KEY: 'native-fixture-key', WORKBENCH_LLM_MODEL: 'gemini-2.5-flash',
      WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta` })
    config.structuredOutputs = true
    extractor = new HarnessExtractor(config)
    const message: SourceMessage = { id: 'native-evidence', source: 'codex', sessionId: 'fixture', rootSessionId: 'fixture', projectPath: '/fixture', role: 'user', timestamp: new Date().toISOString(), text: '验证结构化抽取。password=private-fixture-password' }
    expect((await extractor.extract([message], [], []))[0].evidenceIds).toEqual(['native-evidence'])
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].body)).not.toContain('private-fixture-password')
    expect(JSON.stringify(requests[0].body)).not.toContain('database-secret')
    expect(JSON.stringify(requests[0].body)).not.toContain('native-fixture-key')
  })

  it.each(['anthropic-messages', 'openai-responses'] as const)('%s 使用实际 Harness 完成模拟事项抽取', async (format) => {
    const requests: { url: string; headers: Record<string, unknown>; body: any }[] = []
    const text = JSON.stringify({ items: [{ title: '完成协议接入验证', status: 'completed', isPersonal: false, evidenceIds: ['M1'] }] })
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      requests.push({ url: request.url!, headers: request.headers, body: JSON.parse(raw) })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      if (format === 'anthropic-messages') {
        send('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'gemini-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } })
        send('message_stop', {})
      } else {
        const part = { type: 'output_text', text, annotations: [] }
        const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [part] }
        const result = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'gemini-fixture', output: [item], usage: { input_tokens: 10, output_tokens: 30, total_tokens: 40 } }
        send('response.created', { response: { ...result, status: 'in_progress', output: [] } })
        send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } })
        send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
        send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
        send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part })
        send('response.output_item.done', { output_index: 0, item })
        send('response.completed', { response: result })
      }
      response.end()
    })
    await listenFixtureServer(server)
    runtime = await mkdtemp(join(tmpdir(), 'workbench-protocol-'))
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:test@localhost/test', WORKBENCH_RUNTIME_DIR: runtime,
      WORKBENCH_LLM_API_FORMAT: format, WORKBENCH_LLM_MODEL: 'gemini-fixture', WORKBENCH_LLM_API_KEY: 'fixture-key',
      WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })
    extractor = new HarnessExtractor(config)
    const message: SourceMessage = { id: 'fixture-message', source: 'codex', sessionId: 'fixture', rootSessionId: 'fixture', projectPath: '/fixture', role: 'assistant', timestamp: new Date().toISOString(), text: '已完成协议接入验证。' }
    expect((await extractor.extract([message], [], []))[0].title).toBe('完成协议接入验证')
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url, 'http://fixture').pathname).toBe(format === 'anthropic-messages' ? '/v1/messages' : '/v1/responses')
    expect(requests[0].body.model).toBe('gemini-fixture')
    expect(requests[0].body.stream).toBe(true)
    if (format === 'anthropic-messages') {
      expect(requests[0].headers['x-api-key']).toBe('fixture-key')
      expect(requests[0].headers['anthropic-version']).toBe('2023-06-01')
    } else expect(requests[0].headers.authorization).toBe('Bearer fixture-key')
  }, 60000)
  it('使用固定SDK发出兼容流式请求，无执行工具、无数据库口令', async () => {
    const requests: { url: string; body: any; authorization?: string }[] = []
    const message: SourceMessage = { id: 'fixture-evidence', source: 'codex', sessionId: 'fixture', rootSessionId: 'fixture', projectPath: '/fixture', role: 'assistant', timestamp: new Date().toISOString(), text: '已完成接口测试。password=fixture-password-123' }
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      requests.push({ url: request.url!, body, authorization: request.headers.authorization })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const content = JSON.stringify({ items: [{ ...(requests.length === 1 ? { taskId: 'T999' } : {}), title: '完成接口测试', status: 'completed', isPersonal: true, evidenceIds: ['M1'] }] })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await listenFixtureServer(server)
    const address = server.address() as { port: number }
    runtime = await mkdtemp(join(tmpdir(), 'workbench-harness-'))
    const original = loadConfig({ DATABASE_URL: 'postgresql://app:database-secret@localhost/test', WORKBENCH_LLM_MODEL: '旧环境模型', WORKBENCH_LLM_API_KEY: '旧环境密钥', WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${address.port}/old`, WORKBENCH_RUNTIME_DIR: runtime, WORKBENCH_BATCH_TIMEOUT_MS: '30000' })
    extractor = new HarnessExtractor(original)
    const result = await extractor.extract([message], [], [], { ...original, WORKBENCH_LLM_MODEL: 'glm-5.3-flash', WORKBENCH_LLM_API_KEY: 'fixture-api-key', WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${address.port}/api/coding/v3` })
    expect(result[0].status).toBe('completed')
    expect(result[0].isPersonal).toBe(true)
    expect(result[0].evidenceIds).toEqual([message.id])
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].body)).toContain('新事项必须省略 taskId')
    const req = requests.find((entry) => entry.body.messages?.some((row: any) => row.content?.includes('newMessages')))!
    expect(req.url).toBe('/api/coding/v3/chat/completions')
    expect(req.body.model).toBe('glm-5.3-flash'); expect(req.body.reasoning_effort).toBe('low'); expect(req.body.max_tokens).toBe(8192)
    expect(req.body.tools?.length ?? 0).toBe(0); expect(req.body.store).toBeUndefined()
    expect(req.body.messages.some((row: any) => row.role === 'developer')).toBe(false)
    expect(req.authorization).toBe('Bearer fixture-api-key')
    expect(JSON.stringify(req.body)).not.toContain('database-secret'); expect(JSON.stringify(req.body)).not.toContain('fixture-password-123')
  }, 60000)
  it('公司模型连接失败后自动切换个人模型，后续请求跳过故障服务且全部密钥脱敏', async () => {
    const requests: { url: string; body: string; key?: string }[] = []
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      requests.push({ url: request.url!, body: raw, key: request.headers.authorization })
      if (request.url!.startsWith('/office/')) { response.writeHead(503); response.end('fixture unavailable'); return }
      const content = JSON.stringify({ items: [{ title: '完成模拟工作', status: 'completed', isPersonal: false, evidenceIds: ['M1'] }] })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'fixture-fallback', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'fixture-fallback', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await listenFixtureServer(server)
    runtime = await mkdtemp(join(tmpdir(), 'workbench-model-fallback-'))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:database-secret@localhost/test', WORKBENCH_RUNTIME_DIR: runtime, WORKBENCH_BATCH_TIMEOUT_MS: '30000' })
    config.models = [
      { id: 'office', label: '公司模型', enabled: true, baseUrl: `${base}/office`, name: 'office-model', apiKey: 'fixture-office-secret' },
      { id: 'home', label: '个人模型', enabled: true, baseUrl: `${base}/home`, name: 'home-model', apiKey: 'fixture-home-secret' },
    ]
    config.sourceSecrets = config.models.map((model) => model.apiKey)
    const message: SourceMessage = { id: 'fixture', source: 'codex', sessionId: 'fixture', rootSessionId: 'fixture', projectPath: '/fixture', role: 'assistant', timestamp: new Date().toISOString(), text: '已完成模拟工作。fixture-office-secret fixture-home-secret' }
    extractor = new HarnessExtractor(config)
    expect((await extractor.extract([message], [], []))[0].title).toBe('完成模拟工作')
    expect((await extractor.extract([message], [], []))[0].title).toBe('完成模拟工作')
    expect(requests.map((request) => request.url)).toEqual(['/office/chat/completions', '/home/chat/completions', '/home/chat/completions'])
    expect(requests.map((request) => request.key)).toEqual(['Bearer fixture-office-secret', 'Bearer fixture-home-secret', 'Bearer fixture-home-secret'])
    const bodies = requests.map((request) => request.body).join('')
    expect(bodies).not.toContain('fixture-office-secret')
    expect(bodies).not.toContain('fixture-home-secret')
  }, 60000)
  it('日报先归类再汇总，与抽取同时运行时提示词隔离，遗漏及超长内容自动修复', async () => {
    const requests: any[] = []
    let groupAttempts = 0, summaryAttempts = 0, compactAttempts = 0
    const at = '2026-10-01T03:00:00Z'
    const message: SourceMessage = { id: 'daily-evidence', source: 'codex', sessionId: 'fixture', rootSessionId: 'fixture', projectPath: '/fixture', role: 'assistant', timestamp: at, text: '正在完善工作日报。password=fixture-password-123' }
    const tasks: Task[] = [
      { id: 'report-1', source: 'codex', reference: 'CX-1', title: '完善工作日报的生成入口', projectPath: '/fixture', createdAt: at, recordedAt: at, completedAt: null,
        evidence: [{ messageId: message.id, source: 'codex', sessionId: 'fixture', projectPath: '/fixture', timestamp: at, quote: message.text }] },
      { id: 'report-2', source: 'claude', reference: 'CC-2', title: '补充工作日报的一键复制', projectPath: '/fixture', createdAt: at, recordedAt: at, completedAt: null },
      { id: 'report-3', source: 'codex', reference: 'CX-3', title: '排查AI工具连接与登录问题', projectPath: '/ai-fixture', createdAt: at, recordedAt: at, completedAt: null },
    ]
    const longText = '推进AI工具与代理环境配置，完成codex-with-chatgpt项目部署和workspace.example固定域名连接，ChatGPT内置浏览器与Gemini CLI登录及代理节点访问仍在排查处理中。'.repeat(15)
    const compactText = '推进AI工具与代理环境配置，完成固定域名接入，继续排查连接和登录问题。'
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      requests.push(body)
      const grouping = body.messages[0].content.includes('工作日报任务归类助手')
      const summarizing = body.messages[0].content.includes('工作日报撰写助手')
      const compacting = body.messages[0].content.includes('工作日报摘要精简助手')
      const content = JSON.stringify(grouping
        ? { groups: ++groupAttempts === 1 ? [{ topic: '工作日报功能', taskIds: ['report-1'] }] : [
          { topic: '工作日报功能', taskIds: ['report-1', 'report-2'] }, { topic: 'AI工具环境配置', taskIds: ['report-3'] },
        ] }
        : { items: summarizing
          ? (++summaryAttempts, [{ groupId: 'group-1', text: '工作日报功能', subItems: ['推进工作日报生成入口。', '补充一键复制功能。'] }, { groupId: 'group-2', text: longText }])
          : compacting ? [{ groupId: 'group-2', text: ++compactAttempts === 1 ? longText : compactText }]
            : [{ title: '完善工作日报功能', status: 'todo', isPersonal: false, evidenceIds: [message.id] }] })
      // 模拟真实请求遇到一次连接中断，下一轮超长后仍有机会修复摘要。
      if (summarizing && summaryAttempts === 1) { response.destroy(); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-report', object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-report', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    await listenFixtureServer(server)
    runtime = await mkdtemp(join(tmpdir(), 'workbench-daily-report-'))
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:database-secret@localhost/test', WORKBENCH_LLM_API_KEY: 'fixture-api-key',
      WORKBENCH_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/coding/v3`, WORKBENCH_RUNTIME_DIR: runtime, WORKBENCH_BATCH_TIMEOUT_MS: '30000' })
    extractor = new HarnessExtractor(config)
    reportExtractor = new HarnessExtractor(config, 'daily-report-harness')
    const [extracted, report] = await Promise.all([extractor.extract([message], [], []), reportExtractor.generateDailyReport('2026-10-01', tasks)])
    expect(extracted[0].status).toBe('todo')
    expect(report).toEqual([
      { text: '推进工作日报生成入口。；补充一键复制功能。', subItems: ['推进工作日报生成入口。', '补充一键复制功能。'], taskIds: ['report-1', 'report-2'], topic: '工作日报功能', projectPaths: ['/fixture'] },
      { text: compactText, taskIds: ['report-3'], topic: 'AI工具环境配置', projectPaths: ['/ai-fixture'] },
    ])
    expect(groupAttempts).toBe(2); expect(summaryAttempts).toBe(2); expect(compactAttempts).toBe(2)
    const extraction = requests.find((body) => body.messages.some((row: any) => row.content?.includes('newMessages')))
    const reports = requests.filter((body) => body.messages.some((row: any) => row.content?.includes('"records":')))
    expect(extraction.messages[0].content).toContain('事项抽取器')
    expect(extraction.messages[0].content).toContain('isPersonal')
    expect(reports[0].messages[0].content).toContain('工作日报任务归类助手')
    expect(JSON.stringify(reports[1])).toContain('日报遗漏了工作记录')
    expect(JSON.stringify(reports.at(-1))).toContain(`${longText.length}个字符`)
    expect(JSON.stringify(reports.at(-1))).not.toContain('report-1')
    expect(JSON.stringify(reports)).not.toContain('password=')
    expect(JSON.stringify(requests)).not.toContain('database-secret')
    expect(JSON.stringify(requests)).not.toContain('fixture-password-123')
    for (const body of requests) expect(body.tools?.length ?? 0).toBe(0)
  }, 60000)
})
