import { afterEach, describe, expect, it, vi } from 'vitest'
import { dueReportJobs, ReportAutomation } from './reportAutomation.js'
import { DailyReportError } from './dailyReport.js'
const settings = {
  dailyReportSchedule: () => ({ enabled: true, times: ['18:00'] }),
  periodicReportSchedule: () => ({ weeklyEnabled: true, weeklyDay: 5, weeklyTime: '18:00', monthlyEnabled: true, monthlyTime: '18:00' }),
}
describe('持久化自动整理补跑计划', () => {
  it('补齐重启期间遗漏的日报和周报，同一时间先安排日报', () => {
    const jobs = dueReportJobs(new Date('2026-10-01T19:00:00+08:00'), new Date('2026-10-03T19:00:00+08:00'), settings)
    expect(jobs.map((job) => [job.kind, job.day])).toEqual([['daily','2026-10-02'],['weekly','2026-10-02'],['daily','2026-10-03']])
    expect(jobs.find((job) => job.kind === 'weekly')?.periodKey).toBe('2026-W40')
  })
  it('月末触发月报，检查点边界与停用设置不重复安排', () => {
    const now = new Date('2026-09-30T18:00:00+08:00')
    const jobs = dueReportJobs(new Date(now.getTime()-1),now,settings)
    expect(jobs.map((job) => job.kind)).toEqual(['daily','monthly'])
    expect(dueReportJobs(now,now,settings)).toEqual([])
    expect(dueReportJobs(new Date(now.getTime()-1),now,{ dailyReportSchedule: () => ({ enabled: false,times:['18:00'] }), periodicReportSchedule: () => ({ ...settings.periodicReportSchedule(),weeklyEnabled:false,monthlyEnabled:false }) })).toEqual([])
  })
})

// 调度流程使用状态仓库桩；领取互斥和过期租约另由真实数据库测试验证。
describe('自动整理执行与恢复', () => {
  afterEach(() => { vi.useRealTimers() })
  function fixture() {
    const scheduledAt = '2026-10-02T10:00:00.000Z'
    const job = { id: `daily:${scheduledAt}`, kind: 'daily' as const, day: '2026-10-02', periodKey: '2026-10-02', scheduledAt, status: 'pending' as const, attempts: 0, error: null, finishedAt: null }
    let pending = true
    const store = {
      scheduleCheckpoint: vi.fn(async () => scheduledAt),
      enqueueReportJobs: vi.fn(async () => {}),
      claimReportJob: vi.fn(async (kinds: string[], _token: string) => {
        if (!pending || !kinds.includes('daily')) return null
        pending = false; return job
      }),
      renewReportJob: vi.fn(async () => {}),
      finishReportJob: vi.fn(async () => {}),
    }
    let changed!: () => void
    const unsubscribe = vi.fn(), options = { ...settings, subscribe: (listener: () => void) => { changed = listener; return unsubscribe } }
    return { store, options, unsubscribe, changed: () => changed(), retry: () => { pending = true } }
  }
  it('等待同步完成，失败只记录安全错误，重启后的待重试任务可完成', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T02:00:00Z'))
    const setup = fixture()
    let ready!: () => void
    const gate = new Promise<void>((resolve) => { ready = resolve })
    const generateQueued = vi.fn().mockRejectedValueOnce(new Error('secret=不应保存的上游请求')).mockResolvedValue({})
    const periodic = { generate: vi.fn() }
    const first = new ReportAutomation(setup.store, setup.options, { generateQueued }, periodic, () => gate)
    const running = first.tick()
    await Promise.resolve(); expect(setup.store.claimReportJob).not.toHaveBeenCalled()
    ready(); await running
    expect(setup.store.finishReportJob).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'failed', expect.stringContaining('将自动重试'))
    expect(JSON.stringify(setup.store.finishReportJob.mock.calls)).not.toContain('secret=')
    await first.close(); setup.retry()
    const restarted = new ReportAutomation(setup.store, setup.options, { generateQueued }, periodic)
    try {
      await restarted.tick()
      expect(generateQueued).toHaveBeenCalledTimes(2)
      expect(setup.store.finishReportJob).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'succeeded')
    } finally { await restarted.close() }
  })
  it('没有日志时标记跳过，禁用计划后不领取该类任务', async () => {
    const setup = fixture(), generateQueued = vi.fn().mockRejectedValue(new DailyReportError('无可整理的日志', 400))
    const automation = new ReportAutomation(setup.store, setup.options, { generateQueued }, { generate: vi.fn() })
    try {
      await automation.tick()
      expect(setup.store.finishReportJob).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'skipped', '该日期没有工作日志')
      setup.retry(); setup.options.dailyReportSchedule = () => ({ enabled: false, times: ['18:00'] })
      await automation.tick()
      expect(generateQueued).toHaveBeenCalledOnce()
      expect(setup.store.claimReportJob).toHaveBeenLastCalledWith(['weekly', 'monthly'], expect.any(String))
    } finally { await automation.close() }
  })
  it('运行期间改变设置不会创建重复定时器，关闭会等待正在保存的报告', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T02:00:00Z'))
    const setup = fixture()
    let finish!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve }), ready = new Promise<void>((resolve) => { entered = resolve })
    const automation = new ReportAutomation(setup.store, setup.options, { generateQueued: vi.fn(async () => { entered(); await gate; return {} as never }) }, { generate: vi.fn() })
    automation.start(); await vi.advanceTimersByTimeAsync(1000); await ready
    setup.changed(); automation.wake()
    expect(vi.getTimerCount()).toBe(1) // 仅租约心跳，报告运行期间不另开调度。
    let closed = false
    const closing = automation.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    finish(); await closing
    expect(setup.unsubscribe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
    expect(setup.store.finishReportJob).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'succeeded')
  })
})
