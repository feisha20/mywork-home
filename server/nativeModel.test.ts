import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'
import { HarnessExtractor } from './harness.js'
import { extractionJsonSchema, nativeRequest } from './nativeModel.js'
import { modelApiEndpoint, MODEL_API_FORMATS } from '../shared/modelApi.js'
import type { SourceMessage } from './records.js'

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
afterEach(() => vi.unstubAllGlobals())

describe('原生结构化输出协议', () => {
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
    await expect(extractor.extract([message], [], [])).rejects.toThrow('模型连接失败或超时')
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
