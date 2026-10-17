import { z } from 'zod'
import { modelApiEndpoint, modelApiFormat } from '../shared/modelApi.js'
import type { Config } from './config.js'
import { ModelConnectionError } from './modelRouting.js'

// strict 模式要求字段全部必填；新事项的 taskId 用 null 表示，由本地校验恢复为未提供。
export const extractionJsonSchema = {
  type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['taskId', 'title', 'status', 'isPersonal', 'evidenceIds'], properties: {
        taskId: { type: ['string', 'null'] }, title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'completed'] },
        isPersonal: { type: 'boolean' }, evidenceIds: { type: 'array', items: { type: 'string' } },
      } } },
  },
}

export function nativeRequest(config: Config, prompt: string, system: string, schema?: object) {
  const format = modelApiFormat(config.WORKBENCH_LLM_API_FORMAT)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: object
  if (format === 'gemini_native') {
    headers['x-goog-api-key'] = config.WORKBENCH_LLM_API_KEY
    const model = config.WORKBENCH_LLM_MODEL.replace(/^models\//, '')
    const thinkingConfig = /^gemini-2\.5-(?:flash|pro)(?:-|$)/.test(model) ? { thinkingBudget: 1024 }
      : /^gemini-3(?:[.-]|$)/.test(model) ? { thinkingLevel: 'low' } : undefined
    body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json', ...(schema ? { responseJsonSchema: schema } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}) } }
  } else if (format === 'anthropic-messages') {
    headers['x-api-key'] = config.WORKBENCH_LLM_API_KEY; headers['anthropic-version'] = '2023-06-01'
    body = { model: config.WORKBENCH_LLM_MODEL, system, max_tokens: 8192, stream: false,
      messages: [{ role: 'user', content: prompt }],
      ...(schema ? { tools: [{ name: 'workbench_extract', strict: true, description: '返回事项抽取结果', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'workbench_extract', disable_parallel_tool_use: true } } : {}) }
  } else {
    headers.Authorization = `Bearer ${config.WORKBENCH_LLM_API_KEY}`
    const jsonSchema = { name: 'workbench_extract', strict: true, schema }
    body = format === 'openai-responses'
      ? { model: config.WORKBENCH_LLM_MODEL, instructions: system, input: prompt, max_output_tokens: 8192, stream: false,
        ...(schema ? { text: { format: { type: 'json_schema', ...jsonSchema } } } : {}) }
      : { model: config.WORKBENCH_LLM_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        max_tokens: 8192, stream: false, ...(schema ? { response_format: { type: 'json_schema', json_schema: jsonSchema } } : {}) }
  }
  return { url: modelApiEndpoint(config.WORKBENCH_LLM_BASE_URL, format, config.WORKBENCH_LLM_MODEL), headers, body }
}

function responseText(result: any, config: Config): string {
  const format = modelApiFormat(config.WORKBENCH_LLM_API_FORMAT)
  if (format === 'gemini_native') {
    const candidate = result.candidates?.[0]
    if (candidate?.finishReason !== 'STOP') throw new Error('模型响应不完整')
    return candidate.content?.parts?.filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join('') ?? ''
  }
  if (format === 'anthropic-messages') {
    if (!['end_turn', 'tool_use'].includes(result.stop_reason)) throw new Error('模型响应不完整')
    const tool = result.content?.find((part: any) => part.type === 'tool_use' && part.name === 'workbench_extract')
    return tool ? JSON.stringify(tool.input) : result.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') ?? ''
  }
  if (format === 'openai-responses') {
    if (result.status !== 'completed') throw new Error('模型响应不完整')
    return result.output?.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content ?? [])
      .filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('') ?? ''
  }
  if (result.choices?.[0]?.finish_reason !== 'stop') throw new Error('模型响应不完整')
  return result.choices[0].message?.content ?? ''
}

// 不把上游错误正文、请求头或输出内容带入运行记录。
export class NativeModelClient {
  private active = new Set<AbortController>()
  private stopped = false
  close() { this.stopped = true; for (const controller of this.active) controller.abort() }
  async run<T>(prompt: string, system: string, parse: (raw: string) => T, timeoutMs: number, attempts: number, config: Config, schema?: object): Promise<T> {
    if (this.stopped) throw new Error('抽取服务正在关闭')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    this.active.add(controller)
    let feedback = ''
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (controller.signal.aborted) throw new ModelConnectionError('模型请求超时')
        const request = nativeRequest(config, `${prompt}${attempt ? `\n上次输出未通过校验：${feedback}。请重新按约定输出，新事项必须省略 taskId 或使用 null。` : ''}`, system, schema)
        let result: unknown
        try {
          const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
            signal: controller.signal, redirect: 'error' })
          if (!response.ok) { await response.body?.cancel(); throw new ModelConnectionError('模型连接失败，请检查协议支持、密钥及额度') }
          const reader = response.body!.getReader()
          const chunks: Uint8Array[] = []
          let length = 0
          try {
            while (true) {
              const part = await reader.read()
              if (part.done) break
              length += part.value.length
              if (length > 2 * 1024 * 1024) throw new ModelConnectionError('模型响应超过大小限制')
              chunks.push(part.value)
            }
          } finally { await reader.cancel().catch(() => {}) }
          result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          if (this.stopped) throw new Error('抽取服务正在关闭')
          throw error instanceof ModelConnectionError ? error : new ModelConnectionError('模型连接失败或超时')
        }
        try { return parse(responseText(result, config)) }
        catch (error) {
          // 本地校验只返回固定类别或字段路径，避免模型正文随修复提示再次传播。
          feedback = error instanceof z.ZodError ? error.issues.map((issue) => issue.path.join('.')).join('；').slice(0, 500)
            : error instanceof SyntaxError ? 'JSON格式无效'
              : error instanceof Error && /^(输出包含未知来源证据|输出包含未知事项 ID|输出没有引用本批新增消息)/.test(error.message) ? error.message : '输出结构不符合约定'
          if (attempt === attempts - 1) throw Object.assign(new Error('模型输出多次未通过格式或来源证据校验'), { validationFeedback: feedback })
        }
      }
      throw new Error('抽取未产生结果')
    } finally { clearTimeout(timer); this.active.delete(controller) }
  }
}
