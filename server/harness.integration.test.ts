import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { HarnessExtractor } from './harness.js'
import type { SourceMessage } from './records.js'
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
  it('日报先归类再精简，与抽取同时运行时提示词隔离，遗漏及超长内容自动修复', async () => {
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
    const longText = '推进AI工具与代理环境配置，完成codex-with-chatgpt项目部署和workspace.example固定域名连接，ChatGPT内置浏览器与Gemini CLI登录及代理节点访问仍在排查处理中。'
    const compactText = '推进AI工具与代理环境配置，完成固定域名接入，继续排查连接和登录问题。'
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      requests.push(body)
      const grouping = body.messages[0].content.includes('工作日报任务归类助手')
      const summarizing = body.messages[0].content.includes('精简工作日报撰写助手')
      const compacting = body.messages[0].content.includes('工作日报摘要精简助手')
      const content = JSON.stringify(grouping
        ? { groups: ++groupAttempts === 1 ? [{ topic: '工作日报功能', taskIds: ['report-1'] }] : [
          { topic: '工作日报功能', taskIds: ['report-1', 'report-2'] }, { topic: 'AI工具环境配置', taskIds: ['report-3'] },
        ] }
        : { items: summarizing
          ? (++summaryAttempts, [{ groupId: 'group-1', text: '推进工作日报生成与一键复制功能，整合相关工作进展。' }, { groupId: 'group-2', text: longText }])
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
      { text: '推进工作日报生成与一键复制功能，整合相关工作进展。', taskIds: ['report-1', 'report-2'], topic: '工作日报功能', projectPaths: ['/fixture'] },
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
