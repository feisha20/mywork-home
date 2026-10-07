import { afterEach, describe, expect, it, vi } from 'vitest'
import { legacyReportMarkdown } from './legacyPeriodicReports'
afterEach(() => vi.unstubAllGlobals())
describe('旧版周月报数据库迁移素材', () => {
  it('读取原版正文，损坏或过大缓存不会进入迁移', () => {
    vi.stubGlobal('localStorage',{getItem:() => JSON.stringify({'2026-W40':{markdown:'# 原版周报'}})})
    expect(legacyReportMarkdown('2026-W40')).toBe('# 原版周报')
    vi.stubGlobal('localStorage',{getItem:() => '损坏缓存'})
    expect(legacyReportMarkdown('2026-W40')).toBeNull()
    vi.stubGlobal('localStorage',{getItem:() => JSON.stringify({'2026-W40':{markdown:'文'.repeat(100001)}})})
    expect(legacyReportMarkdown('2026-W40')).toBeNull()
  })
})
