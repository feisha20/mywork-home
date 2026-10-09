import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'
import { ModelConnectionError, ModelRouter } from './modelRouting.js'

const config = () => ({ ...loadConfig({ DATABASE_URL: 'postgresql://app:test@localhost/test' }), models: [
  { id: 'office', label: '公司模型', enabled: true, baseUrl: 'https://office.example/v1', name: 'office', apiKey: 'office-key' },
  { id: 'home', label: '个人模型', enabled: true, baseUrl: 'https://home.example/v1', name: 'home', apiKey: 'home-key' },
] })
afterEach(() => vi.useRealTimers())
describe('模型自动切换', () => {
  it('跨协议故障切换保留每个候选模型的 API 格式，修改格式后解除旧协议冷却', async () => {
    const router = new ModelRouter()
    const value = { ...config(), models: config().models.map((model, index) => ({ ...model,
      apiFormat: index ? 'anthropic-messages' as const : 'openai-responses' as const })) }
    const formats: string[] = []
    await router.run(value, 180_000, async (candidate) => {
      formats.push(candidate.WORKBENCH_LLM_API_FORMAT)
      if (candidate.WORKBENCH_LLM_MODEL === 'office') throw new ModelConnectionError('模拟故障')
      return '成功'
    })
    expect(formats).toEqual(['openai-responses', 'anthropic-messages'])
    expect(router.status(value).nextModelId).toBe('home')
    value.models[0].apiFormat = 'anthropic-messages'
    expect(router.status(value).nextModelId).toBe('office')
  })
  it('并发调用显示实际模型，单次结束不会提前清除状态，失败后清除状态', async () => {
    const router = new ModelRouter(), value = config()
    const finish: (() => void)[] = []
    const request = () => new Promise<void>((resolve) => { finish.push(resolve) })
    const first = router.run(value, 180_000, request), second = router.run(value, 180_000, request)
    expect(router.status(value).activeModelIds).toEqual(['office'])
    finish[0](); await first
    expect(router.status(value).activeModelIds).toEqual(['office'])
    finish[1](); await second
    expect(router.status(value).activeModelIds).toBeUndefined()
    await expect(router.run(value, 180_000, async () => { throw new Error('输出校验失败') })).rejects.toThrow('输出校验失败')
    expect(router.status(value).activeModelIds).toBeUndefined()
  })
  it('优先模型失败后使用独立地址与密钥的备用模型，冷却后恢复优先级', async () => {
    vi.useFakeTimers()
    const router = new ModelRouter(), value = config()
    const request = vi.fn(async (candidate) => {
      if (candidate.WORKBENCH_LLM_MODEL === 'office') throw new ModelConnectionError('模型连接失败')
      return candidate.WORKBENCH_LLM_MODEL
    })
    expect(await router.run(value, 180_000, request)).toBe('home')
    expect(request.mock.calls.map(([candidate]) => candidate.WORKBENCH_LLM_API_KEY)).toEqual(['office-key', 'home-key'])
    expect(request.mock.calls[1][0].WORKBENCH_LLM_BASE_URL).toBe('https://home.example/v1')
    expect(router.status(value)).toEqual({ preferredModelId: 'office', nextModelId: 'home', lastUsedModelId: 'home', coolingModelIds: ['office'] })
    expect(JSON.stringify(router.status(value))).not.toContain('key')
    request.mockClear()
    await router.run(value, 180_000, request)
    expect(request.mock.calls).toHaveLength(1)
    vi.advanceTimersByTime(60_001)
    expect(router.status(value)).toMatchObject({ nextModelId: 'office', lastUsedModelId: 'home', coolingModelIds: [] })
    expect(await router.run(value, 180_000, async (candidate) => candidate.WORKBENCH_LLM_MODEL)).toBe('office')
    expect(router.status(value).lastUsedModelId).toBe('office')
  })
  it('关闭自动切换时不调用备用模型；输出校验失败也不切换', async () => {
    const request = vi.fn(async () => { throw new ModelConnectionError('模型连接失败') })
    await expect(new ModelRouter().run({ ...config(), autoSwitchModels: false }, 180_000, request)).rejects.toThrow('模型连接失败')
    expect(request).toHaveBeenCalledTimes(1)
    const invalid = vi.fn(async () => { throw new Error('来源证据无效') })
    await expect(new ModelRouter().run(config(), 180_000, invalid)).rejects.toThrow('来源证据无效')
    expect(invalid).toHaveBeenCalledTimes(1)
  })
  it('跳过停用或无密钥的模型，全部失败时返回错误，修改密钥解除冷却', async () => {
    const router = new ModelRouter(), value = config()
    value.models[0].enabled = false
    expect(router.candidates(value).map((model) => model.id)).toEqual(['home'])
    value.models[0].enabled = true; value.models[0].apiKey = ''
    expect(router.candidates(value).map((model) => model.id)).toEqual(['home'])
    value.models[0].apiKey = 'office-key'
    const request = vi.fn(async () => { throw new ModelConnectionError('模型请求超时') })
    await expect(router.run(value, 180_000, request)).rejects.toThrow('模型请求超时')
    expect(request).toHaveBeenCalledTimes(2)
    expect(router.candidates(value)).toHaveLength(0)
    await expect(router.run(value, 180_000, request)).rejects.toThrow('所有模型暂时不可用')
    expect(request).toHaveBeenCalledTimes(2)
    value.models[0].apiKey = 'replacement'
    expect(router.candidates(value).map((model) => model.id)).toEqual(['office'])
  })
  it('优先服务等待不超过30秒，备用服务使用剩余时间；成功时不发重复请求', async () => {
    vi.useFakeTimers()
    const budgets: number[] = [], router = new ModelRouter()
    await router.run(config(), 180_000, async (candidate, budget) => {
      budgets.push(budget)
      if (candidate.WORKBENCH_LLM_MODEL === 'office') { vi.advanceTimersByTime(30_000); throw new ModelConnectionError('模型请求超时') }
      return '成功'
    })
    expect(budgets).toEqual([30_000, 150_000])
    const request = vi.fn(async () => '成功')
    await new ModelRouter().run(config(), 180_000, request)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
