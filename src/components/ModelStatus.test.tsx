import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { modelUsage, modelChipDisplay } from '../../shared/modelUsage'
import { ModelStatus } from './ModelStatus'

const profiles = [
  { id: 'first', label: '个人 DeepSeek', name: 'deepseek-flash', apiKey: '机密密钥', baseUrl: '机密地址' },
  { id: 'backup', label: '火山个人', name: 'glm-5.3-flash', apiKey: '备用密钥', baseUrl: '备用地址' },
]
describe('工作流模型信息', () => {
  it('芯片使用实际调用模型的别名，缺少别名时显示配置名称，提示保留完整型号', () => {
    const models = [{ ...profiles[0], alias: 'DeepSeek' }, { ...profiles[1], alias: 'GLM' }]
    const usage = modelUsage(models, { preferredModelId: 'first', nextModelId: 'first', lastUsedModelId: null, activeModelIds: ['backup'], coolingModelIds: [] }, true)
    expect(modelChipDisplay(usage)).toEqual({ text: 'GLM', title: 'glm-5.3-flash' })
    expect(usage.active[0].name).toBe('glm-5.3-flash')
    const legacy = modelUsage(profiles, { preferredModelId: 'first', nextModelId: 'first', lastUsedModelId: null, coolingModelIds: [] }, true)
    expect(modelChipDisplay(legacy)).toEqual({ text: '个人 DeepSeek', title: 'deepseek-flash' })
  })
  it('首选恢复后仍明确标出最近成功的备用模型，不将其当成当前请求', () => {
    const usage = modelUsage(profiles, { preferredModelId: 'first', nextModelId: 'first', lastUsedModelId: 'backup', coolingModelIds: [] }, true)
    const html = renderToStaticMarkup(<ModelStatus usage={usage} />)
    expect(html).toContain('下次优先'); expect(html).toContain('个人 DeepSeek')
    expect(html).toContain('最近成功'); expect(html).toContain('glm-5.3-flash')
    expect(html).not.toContain('正在调用')
    expect(JSON.stringify(usage)).not.toContain('密钥'); expect(JSON.stringify(usage)).not.toContain('地址')
  })
  it('实际调用备用模型时突出备用模型，同时显示等待恢复状态', () => {
    const usage = modelUsage(profiles, { preferredModelId: 'first', nextModelId: 'backup', lastUsedModelId: null, activeModelIds: ['backup'], coolingModelIds: ['first'] }, true)
    const html = renderToStaticMarkup(<ModelStatus usage={usage} />)
    expect(html).toContain('正在调用'); expect(html).toContain('火山个人')
    expect(html).toContain('部分模型等待恢复'); expect(html).not.toContain('个人 DeepSeek')
  })
  it('全部模型冷却时显示不可用，不用旧成功结果冒充可用模型', () => {
    const usage = modelUsage(profiles, { preferredModelId: 'first', nextModelId: null, lastUsedModelId: 'backup', coolingModelIds: ['first', 'backup'] }, true)
    const html = renderToStaticMarkup(<ModelStatus usage={usage} legacyModel="旧模型" />)
    expect(html).toContain('暂无可用模型')
    expect(html).not.toContain('下次优先'); expect(html).not.toContain('旧模型')
  })
})
