import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

interface UserMenuProps {
  onOpenScheduledTasks: () => void
  onOpenSettings: () => void
  onEnterSpace: () => void
}

export function UserMenu({ onOpenSettings, onEnterSpace, onOpenScheduledTasks }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="user-menu-container" ref={menuRef}>
      <button
        type="button"
        className={`user-pill user-menu-trigger${open ? ' is-active' : ''}`}
        aria-label="个人选项菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        title="点击展开个人与工作台选项"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>个人工作空间</span>
        <span className="user-avatar" aria-hidden="true">我</span>
        <Icon name="chevron-down" className={`user-menu-chevron${open ? ' is-flipped' : ''}`} />
      </button>

      {open && (
        <div className="user-menu-dropdown" role="menu" aria-label="个人选项">
          <div className="user-menu-header">
            <span className="user-avatar mini" aria-hidden="true">我</span>
            <div className="user-menu-meta">
              <strong>我的工作台</strong>
              <small>已连接本机数据库</small>
            </div>
          </div>
          <div className="user-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="user-menu-item highlight-item"
            onClick={() => {
              setOpen(false)
              onEnterSpace()
            }}
          >
            <span className="user-menu-item-icon space-icon">
              <Icon name="book" />
            </span>
            <div className="user-menu-item-content">
              <span className="user-menu-item-title">进入个人空间</span>
              <span className="user-menu-item-desc">全屏沉淀工作周报与月报复盘</span>
            </div>
            <span className="user-menu-badge">全屏</span>
          </button>
          <button type="button" role="menuitem" className="user-menu-item" onClick={() => { setOpen(false); onOpenScheduledTasks() }}>
            <span className="user-menu-item-icon"><Icon name="calendar" /></span>
            <div className="user-menu-item-content">
              <span className="user-menu-item-title">计划任务</span>
              <span className="user-menu-item-desc">按周期自动生成日报、OKR 等待办</span>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            className="user-menu-item"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
          >
            <span className="user-menu-item-icon">
              <Icon name="settings" />
            </span>
            <div className="user-menu-item-content">
              <span className="user-menu-item-title">工作台设置</span>
              <span className="user-menu-item-desc">配置模型、会话采集与渠道参数</span>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
