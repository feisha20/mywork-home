import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'
import { HarnessExtractor } from './harness.js'
import { extractionJsonSchema, nativeRequest, NativeModelClient } from './nativeModel.js'
import { modelApiEndpoint, MODEL_API_FORMATS } from '../shared/modelApi.js'
import type { SourceMessage } from './records.js'
import { aggregatePeriodData } from '../src/domain/periodicReport.js'
import { logger } from './logger.js'

const message: SourceMessage = { id: 'real-evidence', source: 'codex', sessionId: 'test', rootSessionId: 'test', projectPath: '/fixture', role: 'user', timestamp: '2026-10-17T01:00:00Z', text: '修复工作记录。password=private-password' }
const item = { taskId: null, title: '完善工作记录', status: 'todo', isPersonal: false, evidenceIds: ['M1'] }
let fixtureSequence = 0
const config = () => loadConfig({ DATABASE_URL: 'postgresql://app:database-password@localhost/test', WORKBENCH_LLM_API_KEY: 'fixture-key', WORKBENCH_LLM_MODEL: 'gemini-2.5-flash', WORKBENCH_LLM_BASE_URL: `https://fixture-${++fixtureSequence}.example/v1beta` })
function reply(format: string, output: unknown = { items: [item] }) {
  const text = JSON.stringify(output)
  return format === 'gemini_native' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '不应引用的推理' }, { text }] } }] }
    : format === 'anthropic-messages' ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'workbench_extract', input: output }] }
      : format === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

const periodData = () => aggregatePeriodData('2026-11-02', '2026-11-08', [{ day: '2026-11-02', generatedAt: '2026-11-02T01:00:00Z',
  revision: 1, recordCount: 2, recordVersions: {}, items: [
    { text: '完成虚构订单接口验证', taskIds: ['one'] }, { text: '完成虚构库存接口验证', taskIds: ['two'] },
  ] }], [])
const periodOutput = (ids = ['R1', 'R2']) => ({ achievements: [{ topic: '虚构商城', outcomes: ['完成订单和库存接口验证'], sourceIds: ids }],
  omittedSourceIds: [], inProgress: [], nextPlan: [] })

describe('周月报直接请求模型', () => {
  it('DeepSeek 周报每次生成和修复都显式使用低强度思考，日志可区分校验重试', async () => {
    const info = vi.spyOn(logger, 'info'), warn = vi.spyOn(logger, 'warn')
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(reply('openai-completions', periodOutput(['R1']))))
      .mockResolvedValueOnce(Response.json(reply('openai-completions', periodOutput())))
    vi.stubGlobal('fetch', fetcher)
    const extractor = new HarnessExtractor({ ...config(), WORKBENCH_LLM_MODEL: 'deepseek-flash', WORKBENCH_LLM_BASE_URL: 'https://api.deepseek.com' })
    try {
      await expect(extractor.generatePeriodicReport('weekly', periodData())).resolves.toHaveLength(3)
      for (const [, request] of fetcher.mock.calls) {
        expect(JSON.parse(request.body)).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
        expect(JSON.parse(request.body)).not.toHaveProperty('max_tokens')
      }
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, stage: '校验输出', category: '遗漏成果素材', willRetry: true }), '原生模型输出校验失败')
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }), '原生模型输出校验通过')
      const starts = info.mock.calls.filter(([, message]) => message === '原生模型请求开始')
      expect(starts).toHaveLength(2)
      expect(starts[0][0].callId).toBe(starts[1][0].callId)
      expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toMatch(/虚构商城|fixture-key|api.deepseek.com|R2/)
    } finally { await extractor.close() }
  })
  it.each(['等待响应头', '读取响应体'])('超时日志准确标记%s，避免把请求超时误判成校验重试', async (stage) => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, 'warn')
    vi.stubGlobal('fetch', vi.fn((_url, request) => stage === '等待响应头'
      ? new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('模拟中断'))))
      : Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(' '))
        request.signal.addEventListener('abort', () => controller.error(new Error('模拟中断')))
      } })))))
    const client = new NativeModelClient()
    try {
      const result = client.run('虚构输入', '虚构规则', JSON.parse, 100, 3, config())
      const rejection = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ stage, attempt: 1, code: 'TIMEOUT', receivedBytes: stage === '读取响应体' ? 1 : 0 }), '原生模型请求中断')
      expect(warn.mock.calls.some(([, message]) => message === '原生模型输出校验失败')).toBe(false)
    } finally { client.close() }
  })
  it.each(MODEL_API_FORMATS)('%s 无需开启结构化输出，遗漏素材时精确修复并校验', async (format) => {
    const response = (ids: string[]) => format === 'anthropic-messages'
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(periodOutput(ids)) }] }
      : reply(format, periodOutput(ids))
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(response(['R1'])))
      .mockResolvedValueOnce(Response.json(response(['R1', 'R2'])))
    vi.stubGlobal('fetch', fetcher)
    const extractor = new HarnessExtractor({ ...config(), WORKBENCH_LLM_API_FORMAT: format, structuredOutputs: false })
    try {
      expect((await extractor.generatePeriodicReport('weekly', periodData()))[0].items).toEqual(['【虚构商城】完成订单和库存接口验证'])
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[1][1].body).toContain('缺少 1 条，请补齐 R2')
      expect(fetcher.mock.calls[1][1].body).not.toContain('新事项必须省略 taskId')
      const body = JSON.parse(fetcher.mock.calls[0][1].body)
      expect(body.stream).not.toBe(true)
      expect(body.tools).toBeUndefined()
      expect(body.response_format).toBeUndefined()
      if (format === 'anthropic-messages') expect(body.max_tokens).toBe(8192)
      else {
        expect(body).not.toHaveProperty('max_tokens')
        expect(body).not.toHaveProperty('max_output_tokens')
        expect(body.generationConfig ?? {}).not.toHaveProperty('maxOutputTokens')
      }
    } finally { await extractor.close() }
  })
  it('接口 400 立即切换备用，日志记录状态及模型编号，不包含上游正文与密钥', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('上游私有错误详情', { status: 400 }))
      .mockResolvedValueOnce(Response.json(reply('openai-completions', periodOutput())))
    vi.stubGlobal('fetch', fetcher)
    const current = config()
    current.models = ['period-first', 'period-second'].map(id => ({ id, label: id, enabled: true,
      baseUrl: `https://${id}.example`, name: id, apiFormat: 'openai-completions', apiKey: `key-${id}` }))
    const extractor = new HarnessExtractor(current)
    try {
      await expect(extractor.generatePeriodicReport('weekly', periodData())).resolves.toHaveLength(3)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }), '模型接口返回错误状态')
      for (const [, request] of fetcher.mock.calls) expect(JSON.parse(request.body)).not.toHaveProperty('max_tokens')
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'period-first', code: 'CONNECTION', httpStatus: 400, elapsedMs: expect.any(Number) }), '周月报候选模型失败')
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/上游私有错误详情|key-period|https:/)
    } finally { await extractor.close() }
  })
  it('超时中断 HTTP 请求并切换备用，使用周月报独立时限', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockImplementationOnce((_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('模拟中断')))
    })).mockResolvedValueOnce(Response.json(reply('openai-completions', periodOutput())))
    vi.stubGlobal('fetch', fetcher)
    const current = { ...config(), WORKBENCH_PERIODIC_REPORT_TIMEOUT_MS: 1000, WORKBENCH_BATCH_TIMEOUT_MS: 100 }
    current.models = ['period-slow', 'period-ready'].map(id => ({ id, label: id, enabled: true,
      baseUrl: `https://${id}.example`, name: id, apiFormat: 'openai-completions', apiKey: `key-${id}` }))
    const extractor = new HarnessExtractor(current)
    try {
      const result = extractor.generatePeriodicReport('weekly', periodData())
      await vi.advanceTimersByTimeAsync(499)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toHaveLength(3)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    } finally { await extractor.close() }
  })
})

describe('原生结构化输出协议', () => {
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('官方 DeepSeek %s 按协议传递低强度思考参数', (format) => {
    const body = nativeRequest({ ...config(), WORKBENCH_LLM_BASE_URL: 'https://api.deepseek.com/v1', WORKBENCH_LLM_MODEL: 'deepseek-flash', WORKBENCH_LLM_API_FORMAT: format }, '虚构输入', '规则').body
    expect(body).toMatchObject(format === 'openai-completions' ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
      : format === 'openai-responses' ? { reasoning: { effort: 'low' } } : { thinking: { type: 'enabled' }, output_config: { effort: 'low' } })
  })
  it('其他服务及未确认的 DeepSeek 模型保持原参数，避免协议不兼容', () => {
    for (const [baseUrl, model] of [['https://compatible.example', 'deepseek-flash'], ['https://api.deepseek.com', 'deepseek-chat'], ['https://api.deepseek.com.example', 'deepseek-flash']]) {
      const body = nativeRequest({ ...config(), WORKBENCH_LLM_BASE_URL: baseUrl, WORKBENCH_LLM_MODEL: model }, '虚构输入', '规则').body
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('thinking')
    }
  })
  it.each(MODEL_API_FORMATS)('%s 保留证据校验、修复一次与凭证脱敏', async (format) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(reply(format, { items: [{ ...item, evidenceIds: ['M99'] }] })))
      .mockResolvedValueOnce(Response.json(reply(format)))
    vi.stubGlobal('fetch', fetcher)
    const current = { ...config(), WORKBENCH_LLM_API_FORMAT: format, structuredOutputs: true }
    const extractor = new HarnessExtractor(current)
    try {
      const result = await extractor.extract([message], [], [])
      expect(result[0].evidenceIds).toEqual([message.id])
      expect(result[0].taskId).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
      const [url, request] = fetcher.mock.calls[0]
      expect(url).toBe(modelApiEndpoint(current.WORKBENCH_LLM_BASE_URL, format, current.WORKBENCH_LLM_MODEL))
      const body = JSON.parse(request.body)
      if (format === 'gemini_native') expect(body.generationConfig.maxOutputTokens).toBe(8192)
      else if (format === 'openai-responses') expect(body.max_output_tokens).toBe(8192)
      else expect(body.max_tokens).toBe(8192)
      expect(request.body).not.toContain('private-password'); expect(request.body).not.toContain('database-password'); expect(request.body).not.toContain('fixture-key')
      if (format === 'gemini_native') {
        expect(request.headers['x-goog-api-key']).toBe('fixture-key')
        expect(body.generationConfig).toMatchObject({ responseJsonSchema: extractionJsonSchema, thinkingConfig: { thinkingBudget: 1024 } })
      } else if (format === 'anthropic-messages') {
        expect(body.tool_choice).toMatchObject({ name: 'workbench_extract', type: 'tool' })
        expect(body.tools[0].input_schema).toEqual(extractionJsonSchema)
      } else if (format === 'openai-responses') expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, schema: extractionJsonSchema })
      else expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: extractionJsonSchema } })
    } finally { await extractor.close() }
  })
  it('Gemini 地址归一化和推理档位按模型族生成，未知模型不强塞预算', () => {
    expect(modelApiEndpoint('https://fixture.example/', 'gemini_native', 'models/gemini-2.5-flash')).toBe('https://fixture.example/v1beta/models/gemini-2.5-flash:generateContent')
    const current = { ...config(), WORKBENCH_LLM_API_FORMAT: 'gemini_native' as const }
    for (const [name, expected] of [['gemini-3-pro-preview', { thinkingLevel: 'low' }], ['other-model', undefined]] as const) {
      const request = nativeRequest({ ...current, WORKBENCH_LLM_MODEL: name }, '输入', '约束')
      expect((request.body as any).generationConfig.thinkingConfig).toEqual(expected)
    }
  })
  it('结构化上游不支持或网络失败时切换备用模型，不泄漏上游正文', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('private-server-detail', { status: 400 })).mockResolvedValueOnce(Response.json(reply('gemini_native')))
    vi.stubGlobal('fetch', fetcher)
    const current = config()
    current.models = ['first', 'second'].map((id) => ({ id, label: id, enabled: true, baseUrl: `https://${id}.example`, name: 'gemini-2.5-flash', apiFormat: 'gemini_native', apiKey: `key-${id}` }))
    const extractor = new HarnessExtractor(current)
    try {
      expect((await extractor.extract([message], [], []))[0].evidenceIds).toEqual([message.id])
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[1][0]).toContain('second.example')
    } finally { await extractor.close() }
  })
  it('超过时限中断请求，关闭后不再发送请求', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('模拟中断'))))))
    const current = { ...config(), WORKBENCH_LLM_API_FORMAT: 'gemini_native' as const, WORKBENCH_BATCH_TIMEOUT_MS: 100 }
    const extractor = new HarnessExtractor(current)
    await expect(extractor.extract([message], [], [])).rejects.toMatchObject({ message: '模型请求超时', code: 'TIMEOUT' })
    await extractor.close()
    await expect(extractor.extract([message], [], [])).rejects.toThrow()
  })
  it('拒绝截断输出和超大响应，且不会把输出正文写入错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify({ items: [item] }) }] } }] }))
      .mockResolvedValueOnce(Response.json(reply('gemini_native'))))
    const extractor = new HarnessExtractor({ ...config(), WORKBENCH_LLM_API_FORMAT: 'gemini_native' })
    try { expect(await extractor.extract([message], [], [])).toHaveLength(1) } finally { await extractor.close() }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('私'.repeat(800_000))))
    const oversized = new HarnessExtractor({ ...config(), WORKBENCH_LLM_API_FORMAT: 'gemini_native' })
    try { await expect(oversized.extract([message], [], [])).rejects.toThrow('超过大小限制') } finally { await oversized.close() }
  })
})
