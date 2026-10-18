import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { dateFromKey, sourceInfo } from '../domain/workbench'
import type { Task } from '../domain/workbench'
import { searchWorkItems } from '../data/apiRepository'
import type { SearchHit } from '../../shared/contracts'
import { Icon } from './Icon'

const shortDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })

export interface GlobalSearchProps {
  onSelectDay: (day: string) => void
  onClose: () => void
}

function projectName(task: Task): string | null {
  const path = task.projectPath?.replace(/\\/g, '/')
  return path ? path.slice(path.lastIndexOf('/') + 1) || path : task.zentao?.project ?? task.management?.project ?? null
}

// 状态口径与日志卡片一致：个人事项不进入统计，来源失效的证据只作提示。
type StatusLabel = '待办' | '已完成' | '待复核' | '个人' | '记录'
function statusLabel(hit: SearchHit): StatusLabel {
  if (hit.task.isPersonal) return '个人'
  if (!hit.day) return '待办'
  if (hit.task.evidenceStale) return '待复核'
  return hit.task.completedAt ? '已完成' : '记录'
}

const stateClass: Record<StatusLabel, string> = { 待办: 'pending', 已完成: 'done', 待复核: 'review', 个人: 'plain', 记录: 'plain' }

export function GlobalSearch({ onSelectDay, onClose }: GlobalSearchProps) {
  const [keyword, setKeyword] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 打开面板即聚焦输入框，关闭时焦点还给调用方。
  useEffect(() => { inputRef.current?.focus() }, [])

  // 停止输入 200ms 后再检索，避免每敲一个字都查一次数据库。
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true); setError(null)
      searchWorkItems({ query: keyword.trim() || undefined, kind: 'all', limit: 30 }, controller.signal)
        .then((page) => { if (controller.signal.aborted) return; setHits(page.hits); setTotal(page.total); setActive(0) })
        .catch((cause) => { if (controller.signal.aborted) return; setHits([]); setTotal(0); setError(cause instanceof Error ? cause.message : '检索失败') })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [keyword])

  // 键盘移动时把选中项滚进视口。
  useEffect(() => { listRef.current?.querySelector('.search-result.active')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const groups = useMemo(() => {
    const pending = hits.filter((hit) => !hit.day), recorded = hits.filter((hit) => hit.day)
    return [...pending.length ? [['待办', pending] as const] : [], ...recorded.length ? [['工作日志', recorded] as const] : []]
  }, [hits])

  const choose = (hit: SearchHit) => {
    if (!hit.day) return
    onSelectDay(hit.day)
    onClose()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = (delta: number) => setActive((current) => hits.length ? (current + delta + hits.length) % hits.length : 0)
    const actions: Record<string, () => void> = {
      Escape: () => onClose(),
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => setActive(0),
      End: () => setActive(hits.length - 1),
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[active]
      if (hit) choose(hit)
      return
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  return (
    <div className="search-mask" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="全局检索" onKeyDown={handleKeyDown}>
        <div className="search-field">
          <Icon name="search" />
          <input ref={inputRef} type="search" value={keyword} maxLength={200} spellCheck={false}
            placeholder="搜索标题、编号或项目，回车跳转到对应日期" aria-label="搜索工作事项"
            aria-describedby="search-hint" onChange={(event) => setKeyword(event.target.value)} />
          <button type="button" className="search-close" aria-label="关闭检索" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="search-body" ref={listRef} role="listbox" aria-label="检索结果">
          {groups.map(([label, items]) => (
            <section key={label} className="search-group">
              <h3>{label}<span>{items.length}</span></h3>
              {items.map((hit) => {
                const index = hits.indexOf(hit), task = hit.task
                const project = projectName(task)
                const label = statusLabel(hit)
                return (
                  <button type="button" key={task.id} role="option" aria-selected={index === active}
                    className={`search-result${index === active ? ' active' : ''}`}
                    onClick={() => choose(hit)} onPointerEnter={() => setActive(index)}>
                    <span className="search-result-title">{task.title}</span>
                    <span className="search-result-meta">
                      <span className={`search-state is-${stateClass[label]}`}>{label}</span>
                      <span className="search-source">{task.management ? '禅道 · 测试管理' : task.scheduledPlan ? '计划任务' : task.sourceLabel ?? sourceInfo(task.source).label}</span>
                      {project && <span className="search-project">{project}</span>}
                      <time dateTime={hit.day ?? undefined} title={hit.day ? fullDate.format(dateFromKey(hit.day)) : undefined}>
                        {hit.day ? shortDate.format(dateFromKey(hit.day)) : '未归档'}
                      </time>
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
          {!loading && !error && !hits.length && <div className="search-empty">
            <Icon name="search" />
            <p>{keyword.trim() ? `没有匹配“${keyword.trim()}”的工作事项` : '还没有可检索的工作记录'}</p>
          </div>}
          {loading && <p className="search-status" role="status">正在检索…</p>}
          {error && <p className="search-status is-error" role="alert">{error}</p>}
        </div>
        <p className="search-hint" id="search-hint">↑↓ 选择 · ↵ 跳转到当天日志 · Esc 关闭{total > hits.length ? ` · 已显示 ${hits.length}/${total} 条` : ''}</p>
      </div>
    </div>
  )
}
