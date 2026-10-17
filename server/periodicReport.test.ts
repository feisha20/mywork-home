import { describe, expect, it, vi } from 'vitest'
import { ModelConnectionError } from './modelRouting.js'
import { periodicReportFailure, PeriodicReportService } from './periodicReport.js'
import type { PeriodicReportModel } from '../src/domain/periodicReport.js'
import type { Task } from '../src/domain/workbench.js'
import type { Store } from './store.js'
const task: Task = { id: 'one', source: 'manual', reference: 'TASK-one', title: '完成本期交付', createdAt: '2026-10-02T02:00:00Z', completedAt: '2026-10-02T03:00:00Z', projectPath: '/项目/工作台' }
function repository() {
  const reports = new Map<string, PeriodicReportModel>()
  const tasks = [task]
  const store: Pick<Store, 'periodTasks' | 'dailyReports' | 'periodicReport' | 'periodicReports' | 'savePeriodicReport'> = {
    periodTasks: async () => tasks, dailyReports: async () => [], periodicReports: async () => [...reports.values()],
    periodicReport: async (type,key) => reports.get(`${type}:${key}`) ?? null,
    savePeriodicReport: async (report, expected) => {
      const key = `${report.type}:${report.periodKey}`
      if ((reports.get(key)?.revision ?? 0) !== expected) return null
      const saved = structuredClone({ ...report, revision: expected + 1 }); reports.set(key,saved); return saved
    },
  }
  return { store, tasks }
}
describe('周期报告保存和并发保护', () => {
  it('重新整理调用周期归纳，保存同一份结构化正文与 Markdown，失败保留原稿', async () => {
    const { store } = repository()
    const sections = [
      { title: '一、 本周核心工作成果与进展', items: ['【工作台】\n   - 完成报表归纳\n   - 保留独立成果'] },
      { title: '二、 推进中工作与风险关注', items: ['部署仍待安排'] },
      { title: '三、 下周工作计划', items: ['完成部署后的实际验证'] },
    ]
    const generator = { generatePeriodicReport: vi.fn(async () => sections), close: vi.fn(async () => {}) }
    const service = new PeriodicReportService(store, generator)
    const original = await service.generate('weekly', '2026-W40', 0)
    expect(generator.generatePeriodicReport).toHaveBeenCalledWith('weekly', expect.objectContaining({ completedTasks: [task] }))
    expect(original.sections).toEqual(sections)
    expect(original.markdown).toContain('   - 保留独立成果')
    generator.generatePeriodicReport.mockRejectedValueOnce(new Error('模型请求超时'))
    await expect(service.generate('weekly', '2026-W40', 1)).rejects.toMatchObject({ statusCode: 502 })
    expect(await service.read('weekly', '2026-W40')).toEqual(original)
    await service.edit('weekly', '2026-W40', '人工正文', 1)
    await service.generate('weekly', '2026-W40', undefined, true)
    expect(generator.generatePeriodicReport).toHaveBeenCalledTimes(2)
    await service.close()
    expect(generator.close).toHaveBeenCalledOnce()
  })
  it('归纳期间发生并发编辑时，不覆盖人工正文', async () => {
    const { store } = repository()
    const base = new PeriodicReportService(store)
    await base.generate('weekly', '2026-W40', 0)
    const service = new PeriodicReportService(store, {
      async generatePeriodicReport() {
        await base.edit('weekly', '2026-W40', '并发保存的人工正文', 1)
        return [{ title: '成果', items: ['模型输出'] }]
      },
      async close() {},
    })
    await expect(service.generate('weekly', '2026-W40', 1)).rejects.toMatchObject({ statusCode: 409 })
    expect((await service.read('weekly', '2026-W40'))?.markdown).toBe('并发保存的人工正文')
  })
  it('人工正文真实保存，重读与自动任务均保留编辑，过期版本不能覆盖', async () => {
    const {store}=repository(),service=new PeriodicReportService(store)
    const original=await service.generate('monthly','2026-10',0)
    expect(original.markdown).toContain(task.title)
    await service.edit('monthly','2026-10','# 人工正文\n最终确认。',1)
    expect(await service.read('monthly','2026-10')).toMatchObject({edited:true,revision:2,markdown:'# 人工正文\n最终确认。'})
    expect((await service.read('monthly','2026-10'))?.sections.flatMap((section) => section.items)).toContain('最终确认。')
    expect(await service.generate('monthly','2026-10',undefined,true)).toMatchObject({revision:2,markdown:'# 人工正文\n最终确认。'})
    await expect(service.edit('monthly','2026-10','过期正文',1)).rejects.toMatchObject({statusCode:409})
  })
  it('并发初次生成仅一份保存成功，不会互相覆盖', async () => {
    const { store } = repository(), service = new PeriodicReportService(store)
    const results = await Promise.allSettled([service.generate('monthly','2026-10',0),service.generate('monthly','2026-10',0)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await service.read('monthly','2026-10'))?.revision).toBe(1)
  })
  it('自动整理仅使用已经保存的日报，不额外生成或改写日报', async () => {
    const {store}=repository()
    const daily={day:'2026-10-02',generatedAt:task.createdAt,recordCount:1,revision:1,recordVersions:{},items:[{text:'原来的日报摘要',taskIds:['one'],topic:'原来的主题'}]}
    const service=new PeriodicReportService({...store,dailyReports:async () => [daily]})
    const report=await service.generate('weekly','2026-W40',undefined,true)
    expect(report.sections[0].items).toEqual(['【原来的主题】原来的日报摘要'])
    expect(report.markdown).not.toContain(task.title)
  })
  it('恢复上一轮自动稿为原版，人工正文保留，恢复只执行一次', async () => {
    const {store}=repository(),service=new PeriodicReportService(store)
    const original=await service.generate('monthly','2026-10',0)
    const old={...original,markdown:'上一轮自动拼接结果',sourceVersion:'旧素材版本'}
    await store.savePeriodicReport(old,1)
    const personal=await service.edit('weekly','2026-W40','我的人工正文',0)
    const manual={...personal,sourceVersion:'旧素材版本'}
    await store.savePeriodicReport(manual,1)
    await service.restoreOriginalFormat()
    expect(await service.read('monthly','2026-10')).toMatchObject({markdown:original.markdown,revision:3})
    expect(await service.read('weekly','2026-W40')).toMatchObject({markdown:'我的人工正文',revision:2})
    await service.restoreOriginalFormat()
    expect((await service.read('monthly','2026-10'))?.revision).toBe(3)
  })
})


describe('周月报失败原因提示', () => {
  it('区分超时、连接、冷却与缺少配置，不泄漏上游原文', () => {
    expect(periodicReportFailure(new ModelConnectionError('模型抽取超时，下次同步将重试')).message).toContain('生成超时')
    expect(periodicReportFailure(new ModelConnectionError('私有密钥和上游正文')).message).toContain('连接失败')
    expect(periodicReportFailure(new Error('尚未配置可用的模型密钥')).statusCode).toBe(503)
    expect(periodicReportFailure(new Error('所有模型暂时不可用，请在一分钟后重试')).message).toContain('一分钟')
    expect(JSON.stringify(periodicReportFailure(new Error('password=private-credential SQL')))).not.toContain('private-credential')
  })
  it('保留格式与素材校验类别，不返回模型正文或原始反馈', () => {
    for (const [feedback, expected] of [['周期报告遗漏成果素材', '遗漏'], ['成果素材引用未知或重复', '未知或重复'],
      ['相同项目主题必须合并', '重复项目'], ['风险或计划引用了未知素材', '不存在'], ['JSON格式无效', 'JSON'], ['items.0 private-detail', '格式要求']]) {
      const failure = periodicReportFailure(Object.assign(new Error('模型输出多次未通过格式或来源证据校验'), { validationFeedback: feedback }))
      expect(failure.message).toContain(expected)
      expect(failure.message).toContain('原有报告已保留')
      expect(failure.message).not.toContain('private-detail')
    }
  })
})
