import { useEffect, useMemo, useState } from 'react'
import type { DailyReport } from '../../shared/contracts'
import type { Task } from '../domain/workbench'
import { aggregatePeriodData, listRecentMonths, listRecentWeeks, synthesizePeriodicReport, type MonthBounds, type PeriodicReportModel, type WeekBounds } from '../domain/periodicReport'
import { fetchPeriodicReport, fetchPeriodMaterial, generatePeriodicReport, savePeriodicReport } from '../data/apiRepository'
import { legacyReportMarkdown } from '../data/legacyPeriodicReports'
import { copyReportText } from '../data/clipboard'
import { Icon } from './Icon'

interface PersonalSpaceProps { clock: Date; onClose: () => void; onOpenSettings: () => void }
export function PersonalSpace({ clock, onClose, onOpenSettings }: PersonalSpaceProps) {
  const [tab, setTab] = useState<'weekly' | 'monthly'>('weekly')
  const [savedReports, setSavedReports] = useState<Record<string, PeriodicReportModel>>({})
  const weeks = useMemo(() => listRecentWeeks(clock, 8), [clock])
  const months = useMemo(() => listRecentMonths(clock, 6), [clock])
  const [selectedWeek, setSelectedWeek] = useState<WeekBounds & { isCurrent: boolean }>(() => weeks[0])
  const [selectedMonth, setSelectedMonth] = useState<MonthBounds & { isCurrent: boolean }>(() => months[0])
  const currentBounds = tab === 'weekly' ? selectedWeek : selectedMonth
  const currentKey = tab === 'weekly' ? selectedWeek.weekKey : selectedMonth.monthKey
  const [material, setMaterial] = useState<{ key: string; tasks: Task[]; reports: DailyReport[] } | null>(null)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false), [draftMarkdown, setDraftMarkdown] = useState('')
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle'), [showSources, setShowSources] = useState(false)
  const [regenerateFeedback, setRegenerateFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const materialKey = `${tab}:${currentKey}`
  const tasks = material?.key === materialKey ? material.tasks : [], dailyReports = material?.key === materialKey ? material.reports : []
  const aggregated = useMemo(() => aggregatePeriodData(currentBounds.startDate, currentBounds.endDate, dailyReports, tasks), [currentBounds, dailyReports, tasks])
  const activeReport = useMemo(() => savedReports[currentKey] ?? synthesizePeriodicReport(tab, { ...currentBounds, key: currentKey }, dailyReports, tasks), [savedReports, currentKey, tab, currentBounds, dailyReports, tasks])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setIsEditing(false); setCopyState('idle'); setRegenerateFeedback(null)
    void (async () => {
      try {
        let [report, data] = await Promise.all([fetchPeriodicReport(tab, currentKey, controller.signal), fetchPeriodMaterial(tab, currentKey, controller.signal)])
        if (controller.signal.aborted) return
        const legacy = !report ? legacyReportMarkdown(currentKey) : null
        if (legacy) {
          try { report = await savePeriodicReport(tab, currentKey, legacy, 0) }
          catch { report = await fetchPeriodicReport(tab, currentKey, controller.signal); if (!report) throw new Error('旧报告保存到数据库失败，请稍后重试。') }
        }
        if (controller.signal.aborted) return
        setMaterial({ key: materialKey, tasks: data.tasks, reports: data.dailyReports })
        if (report) { const saved = report; setSavedReports((current) => ({ ...current, [currentKey]: saved })) }
      } catch (cause) { if (!controller.signal.aborted) setRegenerateFeedback({ kind: 'error', message: cause instanceof Error ? cause.message : '报告读取失败，请稍后重试。' }) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [tab, currentKey, materialKey])
  useEffect(() => { if (!isEditing) setDraftMarkdown(activeReport.markdown) }, [activeReport, isEditing])
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !isEditing && !saving && !document.querySelector('dialog[open]')) onClose() }
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey)
  }, [isEditing, saving, onClose])
  const handleSaveDraft = async () => {
    setSaving(true)
    try {
      const report = await savePeriodicReport(tab, currentKey, draftMarkdown, activeReport.revision ?? 0)
      setSavedReports((current) => ({ ...current, [currentKey]: report })); setIsEditing(false)
      setRegenerateFeedback({ kind: 'success', message: '修改已保存到数据库。' })
    } catch (cause) { setRegenerateFeedback({ kind: 'error', message: cause instanceof Error ? cause.message : '保存失败，编辑内容已保留。' }) }
    finally { setSaving(false) }
  }
  const handleRegenerate = async () => {
    setSaving(true)
    try {
      const report = await generatePeriodicReport(tab, currentKey, activeReport.revision ?? 0)
      setSavedReports((current) => ({ ...current, [currentKey]: report })); setDraftMarkdown(report.markdown); setIsEditing(false)
      setRegenerateFeedback({ kind: 'success', message: `${tab === 'weekly' ? '周报' : '月报'}已重新整理并保存，汇总了 ${report.stats.reportedDays} 篇日报和 ${report.stats.completedTasks} 项完成事项。` })
    } catch (cause) { setRegenerateFeedback({ kind: 'error', message: cause instanceof Error ? cause.message : '整理失败，原有内容已保留。' }) }
    finally { setSaving(false) }
  }
  const handleCopy = async () => {
    try { await copyReportText(isEditing ? draftMarkdown : activeReport.markdown); setCopyState('copied'); setTimeout(() => setCopyState('idle'), 2500) }
    catch { setRegenerateFeedback({ kind: 'error', message: '复制失败，请选中正文手动复制。' }) }
  }

  return (
    <div className="personal-space-view" role="region" aria-label="全屏个人空间">
      {/* 顶部主导航栏 */}
      <header className="space-top-bar">
        <div className="space-top-left">
          <button
            type="button"
            className="space-back-btn"
            disabled={saving} onClick={onClose}
            aria-label="返回工作台"
            title="返回主工作台 (可按 Esc)"
          >
            <Icon name="arrow-left" />
            <span>返回工作台</span>
            <kbd className="space-kbd">Esc</kbd>
          </button>
          <div className="space-breadcrumb-divider" aria-hidden="true" />
          <div className="space-brand">
            <span className="space-brand-tag">个人工作空间</span>
            <h1>工作复盘 · 周报与月报</h1>
          </div>
        </div>

        <div className="space-top-center">
          <nav className="space-tab-nav" role="tablist" aria-label="报表类型选择">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'weekly'}
              className={`space-tab-btn${tab === 'weekly' ? ' is-active' : ''}`}
              disabled={saving} onClick={() => setTab('weekly')}
            >
              <Icon name="calendar" />
              <span>工作周报</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'monthly'}
              className={`space-tab-btn${tab === 'monthly' ? ' is-active' : ''}`}
              disabled={saving} onClick={() => setTab('monthly')}
            >
              <Icon name="book" />
              <span>月度复盘</span>
            </button>
          </nav>
        </div>

        <div className="space-top-right">
          <button
            type="button"
            className="space-settings-btn"
            onClick={onOpenSettings}
            title="打开工作台设置"
          >
            <Icon name="settings" />
            <span>工作台设置</span>
          </button>
        </div>
      </header>

      {/* 主工作区：双栏布局 */}
      <div className="space-layout-body">
        {/* 左栏：周期选择与数据画像 */}
        <aside className="space-sidebar" aria-label="周期列表与统计">
          <div className="space-sidebar-section">
            <div className="space-sidebar-title">
              <span>{tab === 'weekly' ? '历史周选择' : '历史月份选择'}</span>
              <small>{tab === 'weekly' ? '按自然周聚合' : '按自然月聚合'}</small>
            </div>

            <div className="space-period-list" role="listbox" aria-label="选择周期">
              {tab === 'weekly'
                ? weeks.map((item) => {
                    const isSelected = item.weekKey === selectedWeek.weekKey
                    const hasSaved = Boolean(savedReports[item.weekKey])
                    return (
                      <button
                        key={item.weekKey}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`space-period-item${isSelected ? ' is-selected' : ''}`}
                        disabled={saving} onClick={() => setSelectedWeek(item)}
                      >
                        <div className="period-item-header">
                          <strong className="period-item-label">第 {item.weekNumber} 周</strong>
                          {item.isCurrent && <span className="period-tag current">本周</span>}
                          {hasSaved && <span className="period-tag saved">已存</span>}
                        </div>
                        <span className="period-item-dates">
                          {item.startDate.slice(5)} ~ {item.endDate.slice(5)}
                        </span>
                      </button>
                    )
                  })
                : months.map((item) => {
                    const isSelected = item.monthKey === selectedMonth.monthKey
                    const hasSaved = Boolean(savedReports[item.monthKey])
                    return (
                      <button
                        key={item.monthKey}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`space-period-item${isSelected ? ' is-selected' : ''}`}
                        disabled={saving} onClick={() => setSelectedMonth(item)}
                      >
                        <div className="period-item-header">
                          <strong className="period-item-label">{item.year}年{item.monthNumber}月</strong>
                          {item.isCurrent && <span className="period-tag current">本月</span>}
                          {hasSaved && <span className="period-tag saved">已存</span>}
                        </div>
                        <span className="period-item-dates">{item.startDate} 起</span>
                      </button>
                    )
                  })}
            </div>
          </div>

          {/* 周期统计卡片 */}
          <div className="space-stats-card">
            <h3 className="stats-card-heading">
              <Icon name="check" />
              <span>本期数据快照</span>
            </h3>
            <div className="stats-grid">
              <div className="stats-metric">
                <span className="metric-val">{aggregated.stats.reportedDays}</span>
                <span className="metric-lbl">日报记录天数</span>
              </div>
              <div className="stats-metric">
                <span className="metric-val">{aggregated.stats.completedTasks}</span>
                <span className="metric-lbl">累计完成事项</span>
              </div>
              <div className="stats-metric">
                <span className="metric-val">{aggregated.stats.projectCount}</span>
                <span className="metric-lbl">涉及项目数</span>
              </div>
              <div className="stats-metric">
                <span className="metric-val">{aggregated.pendingTasks.length}</span>
                <span className="metric-lbl">推进中待办</span>
              </div>
            </div>
          </div>
        </aside>

        {/* 右栏：报表渲染与操作 */}
        <main className="space-content" aria-label="报表工作区">
          <div className="space-report-card">
            {/* 报表头部 */}
            <div className="space-report-header">
              <div className="report-title-area">
                <h2>{activeReport.title}</h2>
                <div className="report-meta-info">
                  <span className="meta-badge">
                    <Icon name="clock" />
                    <span>日期范围：{currentBounds.startDate} 至 {currentBounds.endDate}</span>
                  </span>
                  <span className="meta-badge">
                    <span>覆盖 {aggregated.stats.reportedDays} 篇日报 · {aggregated.completedTasks.length} 项完成</span>
                  </span>
                </div>
              </div>

              <div className="report-action-bar">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="space-btn space-btn-primary"
                      disabled={saving || !draftMarkdown.trim()} onClick={() => void handleSaveDraft()}
                    >
                      <Icon name="check" />
                      <span>保存修改</span>
                    </button>
                    <button
                      type="button"
                      className="space-btn space-btn-secondary"
                      disabled={saving} onClick={() => {
                        setDraftMarkdown(activeReport.markdown)
                        setIsEditing(false)
                      }}
                    >
                      <span>取消</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="space-btn space-btn-primary"
                      disabled={loading || saving} onClick={() => void handleRegenerate()}
                      title="基于本期日报和任务重新智能提炼"
                    >
                      <Icon name={regenerateFeedback?.kind === 'success' ? 'check' : 'sparkles'} />
                      <span>重新整理</span>
                    </button>
                    <button
                      type="button"
                      className="space-btn space-btn-secondary"
                      disabled={loading || saving} onClick={() => setIsEditing(true)}
                    >
                      <Icon name="edit" />
                      <span>编辑文本</span>
                    </button>
                    <button
                      type="button"
                      className={`space-btn space-btn-secondary${copyState === 'copied' ? ' is-copied' : ''}`}
                      onClick={handleCopy}
                    >
                      <Icon name={copyState === 'copied' ? 'check' : 'copy'} />
                      <span>{copyState === 'copied' ? '已复制 Markdown' : '复制 Markdown'}</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {loading && <p className="space-report-feedback" role="status">正在读取报告…</p>}
            {saving && <p className="space-report-feedback" role="status">正在保存报告…</p>}
            {regenerateFeedback && (
              <div
                className={`space-report-feedback is-${regenerateFeedback.kind}`}
                role={regenerateFeedback.kind === 'error' ? 'alert' : 'status'}
              >
                <Icon name={regenerateFeedback.kind === 'success' ? 'check' : 'close'} />
                <span>{regenerateFeedback.message}</span>
                <button
                  type="button"
                  onClick={() => setRegenerateFeedback(null)}
                  aria-label="关闭整理结果提示"
                >
                  <Icon name="close" />
                </button>
              </div>
            )}

            {/* 报表主体：编辑视图 vs 渲染视图 */}
            <div className="space-report-body">
              {isEditing ? (
                <div className="space-editor-container">
                  <div className="space-editor-tip">
                    <Icon name="edit" />
                    <span>正在直接编辑 Markdown 正文，保存后将自动归档到您的个人空间。</span>
                  </div>
                  <textarea
                    className="space-markdown-editor"
                    value={draftMarkdown}
                    rows={18}
                    disabled={saving} onChange={(e) => setDraftMarkdown(e.target.value)}
                    aria-label="编辑周报/月报内容"
                  />
                </div>
              ) : (
                <div className="space-preview-container">
                  {activeReport.sections.map((section, idx) => (
                    <section key={idx} className="report-preview-section">
                      <h3 className="section-title">{section.title}</h3>
                      <ul className="section-list">
                        {section.items.map((item, itemIdx) => (
                          <li key={itemIdx} className="section-list-item">
                            <span className="bullet-num">{itemIdx + 1}</span>
                            <span className="bullet-text">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>

            {/* 底部素材明细溯源抽屉折叠 */}
            <footer className="space-report-footer">
              <button
                type="button"
                className="space-sources-toggle"
                onClick={() => setShowSources((prev) => !prev)}
                aria-expanded={showSources}
              >
                <Icon name={showSources ? 'chevron-down' : 'chevron-right'} />
                <span>
                  查看关联素材明细 ({aggregated.matchedReports.length} 篇日报，{aggregated.completedTasks.length} 项完成事项)
                </span>
              </button>

              {showSources && (
                <div className="space-sources-panel">
                  {aggregated.matchedReports.length > 0 && (
                    <div className="sources-block">
                      <h4>包含的每日工作日报：</h4>
                      <div className="sources-report-grid">
                        {aggregated.matchedReports.map((rep) => (
                          <div key={rep.day} className="sources-daily-card">
                            <div className="daily-card-day">{rep.day}</div>
                            <ul className="daily-card-items">
                              {rep.items.map((item, idx) => (
                                <li key={idx}>{item.text}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {aggregated.completedTasks.length > 0 && (
                    <div className="sources-block">
                      <h4>期间完成的具体事项：</h4>
                      <div className="sources-task-tags">
                        {aggregated.completedTasks.map((t) => (
                          <span key={t.id} className="task-tag" title={t.title}>
                            {t.title}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </footer>
          </div>
        </main>
      </div>
    </div>
  )
}
