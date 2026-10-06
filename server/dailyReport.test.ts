import { describe, expect, it, vi } from 'vitest'
import type { Task } from '../src/domain/workbench.js'
import { recordsForDate } from '../src/domain/workbench.js'
import type { DailyReport, DailyReportItem } from '../shared/contracts.js'
import { dailyReportInput, parseDailyReport, parseDailyReportGroups, parseDailyReportSummaries, dailyReportSummaryInput,
  parseDailyReportSummaryDrafts, dailyReportSummaryRepairInput, parseDailyReportCompactSummaries, DailyReportService } from './dailyReport.js'
import { excludePersonalReportItems, isRecordInReport, reportRecordVersion } from '../shared/dailyReports.js'
import type { DailyReportGenerator } from './dailyReport.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import type { Store } from './store.js'
import type { SyncService } from './sync.js'

const day = '2026-10-01'
const records: Task[] = [
  { id: 'task-1', reference: 'CX-1', source: 'codex', title: '完善测试计划的列表展示', projectPath: '/项目/测试台',
    createdAt: '2026-09-30T12:00:00Z', recordedAt: '2026-09-30T16:30:00Z', completedAt: null },
  { id: 'task-2', reference: 'CC-2', source: 'claude', title: '补充测试计划的交互与验证', projectPath: '/项目/测试台',
    createdAt: '2026-10-01T01:00:00Z', recordedAt: '2026-10-01T03:00:00Z', completedAt: '2026-10-01T03:00:00Z' },
]
const grouped: DailyReportItem[] = [{ text: '完善测试计划列表与交互，补充验证流程。', taskIds: ['task-1', 'task-2'] }]
function inputStore(tasks = records) {
  const saved = new Map<string, DailyReport>()
  const loadTasks = vi.fn(async () => structuredClone(tasks))
  return { tasks: loadTasks, reportRecords: vi.fn(async (day: string) => recordsForDate({ version: 1, tasks: await loadTasks() }, day)),
    dailyReport: vi.fn(async (day: string) => structuredClone(saved.get(day) ?? null)),
    saveDailyReport: vi.fn(async (report: DailyReport, revision: number) => {
      if ((saved.get(report.day)?.revision ?? 0) !== revision) return null
      saved.set(report.day, structuredClone(report)); return structuredClone(report)
    }),
  }
}
const generator = (): DailyReportGenerator => ({ generateDailyReport: vi.fn(async (_day, input, previous) => [{ ...grouped[0],
  taskIds: [...new Set([...(previous?.items.flatMap((item) => item.taskIds) ?? []), ...input.map((task) => task.id)])].sort() }]), close: vi.fn(async () => {}) })

describe('工作日报的汇总范围与完整性', () => {
  it('个人日志保留归档，初次及补充日报均不向模型发送个人事项', async () => {
    const privateTask = { ...records[0], id: 'private', title: '安排家庭出行', projectPath: '/私人/家庭', isPersonal: true }
    const store = inputStore([...records, privateTask]), model = generator(), service = new DailyReportService(store, model)
    expect(recordsForDate({ version: 1, tasks: [privateTask] }, day)).toHaveLength(1)
    expect(dailyReportInput(day, [...records, privateTask]).records.map((task) => task.taskId)).toEqual(records.map((task) => task.id))
    const report = await service.generate(day)
    expect(report.recordCount).toBe(2)
    expect(vi.mocked(model.generateDailyReport).mock.calls[0][1].some((task) => task.isPersonal)).toBe(false)
    expect(isRecordInReport(privateTask, report)).toBe(false)
    await service.generate(day, 'append')
    expect(model.generateDailyReport).toHaveBeenCalledOnce()
    await service.close()
    const privateModel = generator(), privateService = new DailyReportService(inputStore([privateTask]), privateModel)
    await expect(privateService.generate(day)).rejects.toMatchObject({ statusCode: 400 })
    expect(privateModel.generateDailyReport).not.toHaveBeenCalled()
    await privateService.close()
  })
  it('移除含个人事项的整条混合摘要，释放其中工作记录的整理标记，保留其他摘要', () => {
    const report: DailyReport = { day, generatedAt: records[0].createdAt, revision: 2, recordCount: 3,
      recordVersions: { work: '原工作', private: '原私人', other: '其他工作' }, items: [
        { text: '工作交付与家庭旅行的混合摘要', taskIds: ['work', 'private'] },
        { text: '其他项目成果', taskIds: ['other'] },
      ] }
    const cleaned = excludePersonalReportItems(report, new Set(['private']))
    expect(cleaned.items).toEqual([report.items[1]])
    expect(cleaned.recordVersions).toEqual({ other: '其他工作' })
    expect(cleaned.recordCount).toBe(1)
    expect(report.items).toHaveLength(2)
    expect(excludePersonalReportItems(cleaned, new Set(['private']))).toBe(cleaned)
  })
  it('接受跨来源的同一任务合并，保留来源记录关联', () => {
    expect(parseDailyReport(`\`\`\`json\n${JSON.stringify({ items: grouped })}\n\`\`\``, records)).toEqual(grouped)
  })
  it('拒绝遗漏、重复或伪造来源的汇总', () => {
    for (const items of [
      [{ text: '遗漏第二项', taskIds: ['task-1'] }],
      [{ text: '重复第一项', taskIds: ['task-1', 'task-1', 'task-2'] }],
      [{ text: '伪造记录', taskIds: ['task-1', 'task-2', 'unknown'] }],
      [{ text: '', taskIds: ['task-1', 'task-2'] }],
      [{ text: '汇总\n额外条目', taskIds: ['task-1', 'task-2'] }],
      [],
    ]) expect(() => parseDailyReport(JSON.stringify({ items }), records)).toThrow()
  })
  it('只读取日志简介、项目名和状态，不读取会话证据，并脱敏标题', () => {
    const task = { ...records[0], title: '正在完善测试计划 password=fixture-secret' }
    Object.defineProperty(task, 'evidence', { get() { throw new Error('日报不应读取证据') } })
    const result = dailyReportInput(day, [task])
    expect(result.records[0].completed).toBe(false)
    expect(result.records[0].project).toBe('测试台')
    expect(result.records[0]).not.toHaveProperty('evidence')
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(JSON.stringify(result)).not.toContain('/项目/测试台')
  })
  it('拒绝把同一项目拆成大量小项，摘要超长或再次拆类时重新整理', () => {
    const input = Array.from({ length: 20 }, (_, index) => ({ ...records[0], id: `record-${index}` }))
    expect(() => parseDailyReportGroups(JSON.stringify({ groups: input.map((task) => ({ topic: task.id, taskIds: [task.id] })) }), input)).toThrow('分类过细')
    const groups = parseDailyReportGroups(JSON.stringify({ groups: [{ topic: '测试计划建设', taskIds: ['task-1', 'task-2'] }] }), records)
    expect(() => parseDailyReportSummaries(JSON.stringify({ items: [{ groupId: 'group-1', text: '细'.repeat(81) }] }), groups, records)).toThrow('80字')
    expect(() => parseDailyReportSummaries(JSON.stringify({ items: [{ groupId: 'group-1', text: '第一项' }, { groupId: 'group-1', text: '第二项' }] }), groups, records)).toThrow('不得再次拆分')
  })
  it('英文名称计入字符数，仅精简超长摘要，保留其他条目与来源归属', () => {
    const groups = [{ topic: '测试计划建设', taskIds: ['task-1'] }, { topic: 'AI工具环境配置', taskIds: ['task-2'] }]
    const longText = '推进AI工具与代理环境配置，完成codex-with-chatgpt项目部署和workspace.example固定域名连接，ChatGPT内置浏览器与Gemini CLI登录及代理节点访问仍在排查处理中。'
    const drafts = parseDailyReportSummaryDrafts(JSON.stringify({ items: [
      { groupId: 'group-1', text: grouped[0].text }, { groupId: 'group-2', text: longText },
    ] }), ['group-1', 'group-2'])
    const input = dailyReportSummaryRepairInput(dailyReportSummaryInput(day, records, groups), drafts)
    expect(input.groups.map((group) => group.groupId)).toEqual(['group-2'])
    expect(input.groups[0].draftCharacters).toBe(longText.length)
    expect(input.groups[0].draftCharacters).toBeGreaterThan(80)
    expect(input.groups[0].records.map((record) => record.taskId)).toEqual(['task-2'])
    expect(() => parseDailyReportCompactSummaries(JSON.stringify({ items: [drafts[1]] }), ['group-2'])).toThrow(`${longText.length}个字符`)
    const replacement = { groupId: 'group-2', text: '推进AI工具与代理环境配置，完成固定域名接入，继续排查连接和登录问题。' }
    expect(parseDailyReportCompactSummaries(JSON.stringify({ items: [replacement] }), ['group-2'])).toEqual([replacement])
    expect(() => parseDailyReportCompactSummaries(JSON.stringify({ items: [replacement] }), ['group-1'])).toThrow('不得再次拆分或遗漏')
    const result = parseDailyReportSummaries(JSON.stringify({ items: [drafts[0], replacement] }), groups, records)
    expect(result[0].text).toBe(grouped[0].text)
    expect(result[1]).toMatchObject({ text: replacement.text, taskIds: ['task-2'] })
  })
  it('补充时只读取新简介和原摘要，合并相关分类并保留未涉及条目', () => {
    const previous: DailyReport = { day, generatedAt: records[0].createdAt, recordCount: 2, revision: 1, recordVersions: {}, items: [
      { topic: '测试计划建设', text: '完善测试计划的列表展示。', taskIds: ['task-1'], projectPaths: ['/项目/测试台'] },
      { topic: '发布准备', text: '完成发布检查。', taskIds: ['release-1'], projectPaths: ['/发布'] },
    ] }
    const pending = [records[1]]
    const groups = parseDailyReportGroups(JSON.stringify({ groups: [{ topic: '测试计划建设', taskIds: ['task-2'], existingGroupIds: ['saved-1'] }] }), pending, previous)
    const input = dailyReportSummaryInput(day, pending, groups, [], previous)
    expect(input.groups[0].records.map((record) => record.taskId)).toEqual(['task-2'])
    expect(input.groups[0].previousSummaries).toEqual(['完善测试计划的列表展示。'])
    const merged = parseDailyReportSummaries(JSON.stringify({ items: [{ groupId: 'group-1', text: grouped[0].text }] }), groups, pending, previous)
    expect(merged).toHaveLength(2)
    expect(merged[0].taskIds).toEqual(['task-1', 'task-2'])
    expect(merged[1]).toEqual(previous.items[1])
  })
  it('汇总所选日期全部日志，排除其他日期和未完成手工待办，不改原数据', async () => {
    const tasks: Task[] = [...records,
      { ...records[0], id: '昨天', recordedAt: '2026-09-30T15:59:59Z' },
      { ...records[0], id: '手工待办', source: 'manual', completedAt: null },
      { ...records[0], id: '手工完成', source: 'manual', completedAt: '2026-10-01T04:00:00Z' },
    ]
    const original = structuredClone(tasks), model = generator()
    const service = new DailyReportService(inputStore(tasks), model)
    const result = await service.generate(day)
    expect(result.day).toBe(day); expect(result.recordCount).toBe(3)
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt)
    const passed = vi.mocked(model.generateDailyReport).mock.calls[0][1]
    expect(passed.map((task) => task.id).sort()).toEqual(['task-1', 'task-2', '手工完成'].sort())
    expect(tasks).toEqual(original)
    await service.close()
  })
  it('相同日志的并发请求复用一次生成，其他日期等待后可重试', async () => {
    let finish!: (items: DailyReportItem[]) => void
    const model = generator()
    vi.mocked(model.generateDailyReport).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const service = new DailyReportService(inputStore([...records, { ...records[0], id: '昨天', recordedAt: '2026-09-30T01:00:00Z' }]), model)
    const first = service.generate(day), second = service.generate(day)
    await vi.waitFor(() => expect(model.generateDailyReport).toHaveBeenCalledOnce())
    await expect(service.generate('2026-09-30')).rejects.toMatchObject({ statusCode: 409 })
    finish(grouped)
    expect(await second).toEqual(await first)
    await service.generate(day)
    expect(model.generateDailyReport).toHaveBeenCalledOnce()
    await Promise.all([service.close(), service.close()])
    expect(model.close).toHaveBeenCalledOnce()
    await expect(service.generate(day)).rejects.toMatchObject({ statusCode: 503 })
  })
  it('无日志不调用模型，模型失败后释放生成状态并允许重试', async () => {
    const model = generator()
    const service = new DailyReportService(inputStore(), model)
    await expect(service.generate('2026-09-29')).rejects.toMatchObject({ statusCode: 400 })
    expect(model.generateDailyReport).not.toHaveBeenCalled()
    vi.mocked(model.generateDailyReport).mockRejectedValueOnce(new Error('模型请求超时'))
    await expect(service.generate(day)).rejects.toMatchObject({ statusCode: 504 })
    expect((await service.generate(day)).items).toEqual(grouped)
    await service.close()
  })
  it('保存后再次打开不触发模型，补充只处理新增或更新日志，成功后才标记', async () => {
    const tasks = [...records], store = inputStore(tasks), model = generator()
    const service = new DailyReportService(store, model)
    const first = await service.generate(day)
    expect(first.revision).toBe(1); expect(isRecordInReport(tasks[0], first)).toBe(true)
    tasks.push({ ...records[0], id: 'task-3', title: '补充测试计划导出' })
    const opened = await service.generate(day)
    expect(opened).toEqual(first); expect(model.generateDailyReport).toHaveBeenCalledOnce()
    expect(isRecordInReport(tasks[2], opened)).toBe(false)
    vi.mocked(model.generateDailyReport).mockRejectedValueOnce(new Error('模型失败'))
    await expect(service.generate(day, 'append')).rejects.toMatchObject({ statusCode: 502 })
    expect(await store.dailyReport(day)).toEqual(first)
    const appended = await service.generate(day, 'append')
    expect(vi.mocked(model.generateDailyReport).mock.calls.at(-1)?.[1].map((task) => task.id)).toEqual(['task-3'])
    expect(appended.revision).toBe(2); expect(appended.recordCount).toBe(3)
    expect(isRecordInReport(tasks[2], appended)).toBe(true)
    tasks[0] = { ...tasks[0], title: '完善测试计划展示与筛选' }
    expect(isRecordInReport(tasks[0], appended)).toBe(false)
    await service.generate(day, 'append')
    expect(vi.mocked(model.generateDailyReport).mock.calls.at(-1)?.[1].map((task) => task.id)).toEqual(['task-1'])
    const before = vi.mocked(model.generateDailyReport).mock.calls.length
    await service.generate(day, 'append')
    expect(model.generateDailyReport).toHaveBeenCalledTimes(before)
    await service.close()
  })
  it('保存冲突时不覆盖日报，也不提前标记记录', async () => {
    const store = inputStore(), service = new DailyReportService(store, generator())
    store.saveDailyReport.mockResolvedValueOnce(null)
    await expect(service.generate(day)).rejects.toMatchObject({ statusCode: 409 })
    expect(await store.dailyReport(day)).toBeNull()
    const report = await service.generate(day)
    expect(report.recordVersions['task-1']).toBe(reportRecordVersion(records[0]))
    await service.close()
  })
  it('摘要精简失败和模型连接中断给出明确原因，保留已保存日报与标记', async () => {
    const tasks = [...records], store = inputStore(tasks), model = generator()
    const service = new DailyReportService(store, model), saved = await service.generate(day)
    tasks[0] = { ...tasks[0], title: '补充测试计划筛选' }
    vi.mocked(model.generateDailyReport).mockRejectedValueOnce(Object.assign(new Error('模型校验失败'), { validationFeedback: 'group-2仍有96个字符，严格不超过80字符' }))
    await expect(service.generate(day, 'append')).rejects.toMatchObject({ statusCode: 502, message: '部分日报摘要未能精简到80字符以内，请重试' })
    vi.mocked(model.generateDailyReport).mockRejectedValueOnce(new Error('模型连接失败'))
    await expect(service.generate(day, 'append')).rejects.toMatchObject({ statusCode: 502, message: '模型连接中断，请稍后重试' })
    expect(await store.dailyReport(day)).toEqual(saved)
    expect(isRecordInReport(tasks[0], saved)).toBe(false)
    await service.close()
  })
})

describe('工作日报接口', () => {
  it('校验日期和请求来源，返回合并条目，无日志及模型未配置时给出明确提示', async () => {
    const model = generator(), store = inputStore() as unknown as Store
    const reports = new DailyReportService(store, model)
    const config = loadConfig({ DATABASE_URL: 'postgresql://app:fixture-password@localhost/test', STATIC_DIR: '/不存在的静态目录' })
    const app = await createApp(config, store, {} as SyncService, reports)
    try {
      for (const invalid of ['', '2026-02-30', '2026-13-01', '2026-10-01T00:00:00Z']) {
        expect((await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day: invalid } })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'POST', url: '/api/daily-reports', headers: { origin: 'https://foreign.example' }, payload: { day } })).statusCode).toBe(403)
      expect(model.generateDailyReport).not.toHaveBeenCalled()
      const response = await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day } })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ day, recordCount: 2, items: grouped })
      const empty = await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day: '2026-09-29' } })
      expect(empty.statusCode).toBe(400); expect(empty.json().error).toContain('还没有工作日志')
      const saved = await app.inject({ url: `/api/daily-reports/${day}` })
      expect(saved.json()).toEqual(response.json())
      expect((await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day } })).json()).toEqual(response.json())
      expect(model.generateDailyReport).toHaveBeenCalledOnce()
      vi.mocked(store.tasks).mockResolvedValue([...records, { ...records[0], id: 'new-task' }])
      vi.mocked(model.generateDailyReport).mockRejectedValueOnce(new Error('尚未配置模型密钥 WORKBENCH_LLM_API_KEY'))
      const failed = await app.inject({ method: 'POST', url: '/api/daily-reports', payload: { day, mode: 'append' } })
      expect(failed.statusCode).toBe(503); expect(failed.json().error).toContain('尚未配置模型密钥')
    } finally { await app.close() }
    expect(model.close).toHaveBeenCalledOnce()
  })
})
