import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Icon } from './Icon'

interface SettingsSelectProps<Value extends string> {
  label: string
  value: Value
  options: readonly { value: Value; label: string }[]
  disabled?: boolean
  help?: string
  compact?: boolean
  width?: string | number
  onChange: (value: Value) => void
}

export function SettingsSelect<Value extends string>({
  label,
  value,
  options,
  disabled = false,
  help,
  compact = false,
  width,
  onChange,
}: SettingsSelectProps<Value>) {
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const typedRef = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [placement, setPlacement] = useState({ above: false, maxHeight: 244 })
  const selectedIndex = options.findIndex((option) => option.value === value)
  const expanded = open && !disabled && options.length > 0

  useLayoutEffect(() => { if (disabled) close() }, [disabled])

  // 下拉始终留在设置面板可见区域内，空间不足时向上展开。
  useLayoutEffect(() => {
    if (!expanded) return
    const root = rootRef.current, trigger = triggerRef.current
    if (!root || !trigger) return
    const scrollArea = root.closest('.settings-content')
    const measure = () => {
      const bounds = trigger.getBoundingClientRect()
      const visible = scrollArea?.getBoundingClientRect()
      const top = Math.max(8, visible?.top ?? 8), bottom = Math.min(window.innerHeight - 8, visible?.bottom ?? window.innerHeight - 8)
      if (bounds.bottom <= top || bounds.top >= bottom) { close(); return }
      const below = Math.max(0, bottom - bounds.bottom - 8), above = Math.max(0, bounds.top - top - 8)
      const upwards = below < Math.min(244, options.length * 36 + 14) && above > below
      const next = { above: upwards, maxHeight: Math.min(244, upwards ? above : below) }
      if (next.maxHeight < 36) { close(); return }
      setPlacement((current) => current.above === next.above && current.maxHeight === next.maxHeight ? current : next)
    }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.contains(event.target)) close() }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    if (scrollArea) observer.observe(scrollArea)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [expanded, options.length])

  useLayoutEffect(() => {
    if (!expanded) return
    const menu = menuRef.current, option = menu?.children[activeIndex] as HTMLElement | undefined
    if (!menu || !option) return
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop - 6
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight + 6
  }, [expanded, activeIndex, placement.maxHeight])

  function close() { setOpen(false); typedRef.current = { text: '', time: 0 } }
  function openAt(index: number) {
    if (disabled || !options.length) return
    triggerRef.current?.focus({ preventScroll: true })
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1))); setOpen(true)
  }
  function choose(index: number) {
    const option = options[index]
    if (disabled || !option) return
    close()
    if (option.value !== value) onChange(option.value)
    triggerRef.current?.focus()
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || event.nativeEvent.isComposing) return
    const key = event.key
    if (key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); return }
    if (key === 'Tab') { close(); return }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (event.altKey && key === 'ArrowUp') { close(); return }
      openAt(expanded ? activeIndex + (key === 'ArrowDown' ? 1 : -1) : selectedIndex); return
    }
    if (key === 'Home' || key === 'End') { event.preventDefault(); openAt(key === 'Home' ? 0 : options.length - 1); return }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      if (expanded) choose(activeIndex); else openAt(selectedIndex)
      return
    }
    if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || !options.length) return
    const now = Date.now(), text = `${now - typedRef.current.time < 700 ? typedRef.current.text : ''}${key}`.toLocaleLowerCase()
    typedRef.current = { text, time: now }
    const query = new Set(text).size === 1 ? key.toLocaleLowerCase() : text
    const start = expanded ? activeIndex : Math.max(0, selectedIndex)
    for (let offset = query.length > 1 ? 0 : 1; offset < options.length + (query.length > 1 ? 0 : 1); offset++) {
      const index = (start + offset) % options.length
      if (options[index].label.toLocaleLowerCase().startsWith(query)) { event.preventDefault(); openAt(index); return }
    }
  }

  const selectNode = (
    <div
      ref={rootRef}
      className={`settings-select${compact ? ' is-compact' : ''}${expanded ? ' is-open' : ''}`}
      style={width ? { width: typeof width === 'number' ? `${width}px` : width } : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close()
      }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className="settings-select-trigger"
        disabled={disabled || !options.length}
        aria-label={compact ? label : undefined}
        aria-labelledby={compact ? undefined : `${id}-label ${id}-value`}
        aria-describedby={help ? `${id}-help` : undefined}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-menu` : undefined}
        aria-activedescendant={expanded ? `${id}-option-${activeIndex}` : undefined}
        onClick={() => { if (expanded) close(); else openAt(selectedIndex) }}
        onKeyDown={keyboard}
      >
        <span id={`${id}-value`}>{options[selectedIndex]?.label ?? '请选择'}</span>
        <Icon name="chevron-down" className="settings-select-chevron" />
      </button>
      {expanded && (
        <ul
          ref={menuRef}
          id={`${id}-menu`}
          role="listbox"
          aria-labelledby={compact ? undefined : `${id}-label`}
          className={`settings-select-menu${placement.above ? ' opens-above' : ''}`}
          style={{ maxHeight: placement.maxHeight }}
        >
          {options.map((option, index) => (
            <li
              id={`${id}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`settings-select-option${activeIndex === index ? ' is-active' : ''}`}
              onPointerEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  if (compact) return selectNode

  return (
    <div className="settings-field">
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      {selectNode}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  )
}
