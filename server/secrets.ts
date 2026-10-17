import type { Config } from './config.js'

// 入库、错误记录和模型请求使用同一份凭据，避免漏掉备用模型密钥。
export function runtimeSecrets(config: Config): string[] {
  let password = ''
  try { password = decodeURIComponent(new URL(config.DATABASE_URL).password) } catch { password = '' }
  return [...new Set([config.WORKBENCH_LLM_API_KEY, password, ...config.sourceSecrets, ...(config.models ?? []).map((model) => model.apiKey)].filter(Boolean))]
}
