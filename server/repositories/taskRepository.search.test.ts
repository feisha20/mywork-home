import { describe, expect, it } from 'vitest'
import { searchTaskFilters } from './taskRepository.js'

const base = { kind: 'all' as const }

describe('跨周期检索条件', () => {
  it('默认只过滤已删除和不可见管理事项，不加日期限制', () => {
    const { where, params } = searchTaskFilters(base)
    expect(where).toContain('deleted_at IS NULL')
    expect(where).not.toContain('occurred_at')
    expect(where).not.toContain('record')
    expect(where).not.toContain("ILIKE '%")
    expect(params).toEqual([])
    expect(where).toContain('NOT is_personal')
  })

  it('关键词同时编号、标题和项目名，并转义 ILIKE 通配符', () => {
    const { where, params } = searchTaskFilters({ ...base, query: '报_告 100%' })
    expect(params).toEqual(['%报\\_告 100\\%%'])
    // 三个位置复用同一个参数编号，不再重复传值。
    expect(new Set(where.match(/ILIKE \$\d+/g))).toEqual(new Set(['ILIKE $1']))
  })

  it('筛选待办时要求需人工完成且未完成', () => {
    const { where } = searchTaskFilters({ ...base, kind: 'todo' })
    expect(where).toContain("source IN ('manual','zentao') AND completed_at IS NULL")
  })

  it('筛选日志时只取已归档到日期的事项', () => {
    const { where } = searchTaskFilters({ ...base, kind: 'log' })
    expect(where).toMatch(/recorded_at|completed_at/)
  })

  it('按完成状态筛选时排除自然记录', () => {
    const { where, params } = searchTaskFilters({ ...base, status: 'completed' })
    expect(where).toContain("THEN 'needs_review'")
    expect(where).toContain("WHEN completed_at IS NOT NULL THEN 'completed'")
    expect(params).toEqual(['completed'])
    expect(where).toContain("END)=$1")
  })

  it('来源和关键词同时存在时参数编号连续', () => {
    const { where, params } = searchTaskFilters({ ...base, source: 'codex', query: '重构' })
    // 来源一个参数，关键词一个参数供三个位置复用。
    expect(params).toEqual(['codex', '%重构%'])
    expect(where).toContain('source=$1')
    expect(new Set(where.match(/ILIKE \$\d+/g))).toEqual(new Set(['ILIKE $2']))
  })
})
