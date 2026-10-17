import { modelApiFormat } from '../shared/modelApi.js'
import type { ModelRuntimeStatus } from '../shared/settings.js'
import type { Config } from './config.js'

// 连接错误允许切换；输出校验失败保留原模型的纠错流程。
export class ModelConnectionError extends Error {}
type Model = NonNullable<Config['models']>[number]
export class ModelRouter {
  private listeners = new Set<(event: { from?: string; to?: string }) => void>()
  subscribe(listener: (event: { from?: string; to?: string }) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(event: { from?: string; to?: string } = {}) {
    for (const listener of this.listeners) { try { listener(event) } catch { /* 界面订阅不能中断模型请求。 */ } }
  }
  private lastUsedIdentity: string | null = null
  private failures = new Map<string, number>()
  private active = new Map<string, number>()
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private scheduleRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    if (!this.failures.size) return
    const next = Math.min(...this.failures.values())
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      for (const [key, until] of this.failures) if (until <= Date.now()) this.failures.delete(key)
      this.changed(); this.scheduleRecovery()
    }, Math.max(1, next - Date.now()))
    this.recoveryTimer.unref?.()
  }
  private identity(model: Model) { return JSON.stringify([model.id, model.baseUrl, model.name, model.apiKey, modelApiFormat(model.apiFormat)]) }
  candidates(config: Config): Model[] {
    for (const [key, until] of this.failures) if (until <= Date.now()) this.failures.delete(key)
    const models = (config.models ?? [{ id: 'default', label: '默认模型', enabled: true,
      apiFormat: config.WORKBENCH_LLM_API_FORMAT, baseUrl: config.WORKBENCH_LLM_BASE_URL, name: config.WORKBENCH_LLM_MODEL, apiKey: config.WORKBENCH_LLM_API_KEY }])
      .filter((model) => model.enabled && model.apiKey)
    if (!config.autoSwitchModels) return models.slice(0, 1)
    const ready = models.filter((model) => (this.failures.get(this.identity(model)) ?? 0) <= Date.now())
    return ready
  }
  status(config: Config): ModelRuntimeStatus {
    const next = this.candidates(config)[0]
    const models = config.models ?? [{ id: 'default', label: '默认模型', enabled: true,
      apiFormat: config.WORKBENCH_LLM_API_FORMAT, baseUrl: config.WORKBENCH_LLM_BASE_URL, name: config.WORKBENCH_LLM_MODEL, apiKey: config.WORKBENCH_LLM_API_KEY }]
    return {
      ...(this.active.size ? { activeModelIds: models.filter((model) => this.active.has(this.identity(model))).map((model) => model.id) } : {}),
      preferredModelId: models.find((model) => model.enabled && model.apiKey)?.id ?? null,
      nextModelId: next?.id ?? null,
      lastUsedModelId: models.find((model) => this.identity(model) === this.lastUsedIdentity)?.id ?? null,
      coolingModelIds: models.filter((model) => (this.failures.get(this.identity(model)) ?? 0) > Date.now()).map((model) => model.id),
    }
  }
  async run<T>(config: Config, timeoutMs: number, request: (config: Config, timeoutMs: number) => Promise<T>): Promise<T> {
    const models = this.candidates(config)
    if (!models.length) throw new Error((config.models ?? []).some((model) => model.enabled && model.apiKey)
      ? '所有模型暂时不可用，请在一分钟后重试' : '尚未配置可用的模型密钥')
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    for (const [index, model] of models.entries()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      // 为备用模型保留时间，多个模型时优先服务最多等待 30 秒。
      const budget = index === models.length - 1 ? remaining : Math.min(30_000, Math.max(1, Math.floor(remaining / (models.length - index))))
      const identity = this.identity(model)
      this.active.set(identity, (this.active.get(identity) ?? 0) + 1)
      this.changed(index > 0 ? { from: models[index - 1].id, to: model.id } : {})
      try {
        const result = await request({ ...config, WORKBENCH_LLM_BASE_URL: model.baseUrl,
          WORKBENCH_LLM_MODEL: model.name, WORKBENCH_LLM_API_FORMAT: modelApiFormat(model.apiFormat), WORKBENCH_LLM_API_KEY: model.apiKey }, budget)
        this.lastUsedIdentity = this.identity(model)
        this.failures.delete(this.identity(model))
        this.scheduleRecovery()
        return result
      } catch (error) {
        if (!(error instanceof ModelConnectionError)) throw error
        this.failures.set(this.identity(model), Date.now() + 60_000)
        this.scheduleRecovery()
        lastError = error
      } finally {
        const count = (this.active.get(identity) ?? 1) - 1
        if (count) this.active.set(identity, count)
        else this.active.delete(identity)
        this.changed()
      }
    }
    throw lastError ?? new ModelConnectionError('模型请求超时')
  }
}
export const modelRouter = new ModelRouter()
