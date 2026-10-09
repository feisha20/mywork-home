export const MODEL_API_FORMATS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type ModelApiFormat = typeof MODEL_API_FORMATS[number]
export const modelApiOptions = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
] as const
export function modelApiFormat(value?: ModelApiFormat): ModelApiFormat { return value ?? 'openai-completions' }
// Anthropic SDK 会追加 /v1/messages，兼容填写服务根地址或 /v1。
export function modelApiBase(baseUrl: string, format: ModelApiFormat) {
  const base = baseUrl.replace(/\/+$/, '')
  return format === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base
}
export function modelApiEndpoint(baseUrl: string, format: ModelApiFormat) {
  return `${modelApiBase(baseUrl, format)}${format === 'anthropic-messages' ? '/v1/messages' : format === 'openai-responses' ? '/responses' : '/chat/completions'}`
}
export function modelApiHelp(format: ModelApiFormat) {
  return format === 'anthropic-messages' ? '填写服务根地址或以 /v1 结尾的地址，工作台调用 /v1/messages。'
    : format === 'openai-responses' ? '填写 API 基础地址，工作台自动添加 /responses。'
    : '填写 API 基础地址，工作台自动添加 /chat/completions。'
}
