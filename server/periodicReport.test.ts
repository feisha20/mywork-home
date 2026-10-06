import { describe, expect, it } from 'vitest'
import { PeriodicReportService } from './periodicReport.js'
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
