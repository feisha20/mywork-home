import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PersonalSpace } from './PersonalSpace'
describe('原版个人空间展示', () => {
  it('保留原版三段报告和操作入口', () => {
    const html=renderToStaticMarkup(<PersonalSpace clock={new Date('2026-10-06T03:00:00Z')} onClose={() => {}} onOpenSettings={() => {}} />)
    expect(html).toContain('report-preview-section')
    expect(html).toContain('本周核心工作成果与进展')
    expect(html).toContain('推进中工作与风险关注')
    expect(html).toContain('下周工作计划')
    expect(html).toContain('重新整理')
    expect(html).toContain('编辑文本')
    expect(html).not.toContain('markdown-preview')
    expect(html).not.toContain('自动整理状态')
  })
})
