import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyReportText } from './clipboard'

afterEach(() => vi.unstubAllGlobals())

function fallbackContext(succeeded: boolean) {
  class Element { isConnected = true; focus = vi.fn() }
  const active = new Element()
  const field = { value: '', readOnly: false, style: { cssText: '' }, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() }
  const dialog = { appendChild: vi.fn() }, body = { appendChild: vi.fn() }
  const range = { cloneRange: () => range }
  const selection = { rangeCount: 1, getRangeAt: () => range, removeAllRanges: vi.fn(), addRange: vi.fn() }
  const execCommand = vi.fn(() => succeeded)
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('document', { activeElement: active, createElement: () => field, querySelector: () => dialog, body, execCommand })
  vi.stubGlobal('window', { getSelection: () => selection })
  return { field, dialog, body, active, selection, range, execCommand }
}

describe('一键复制的兼容处理', () => {
  it('优先使用剪贴板API复制完整文本', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyReportText('工作日报\n\n1. 完成验证。')
    expect(writeText).toHaveBeenCalledWith('工作日报\n\n1. 完成验证。')
  })
  it('剪贴板权限受限时在原生日报窗口内复制，并恢复焦点与选区', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('没有权限')) } })
    const context = fallbackContext(true)
    await copyReportText('日报内容')
    expect(context.field.value).toBe('日报内容')
    expect(context.dialog.appendChild).toHaveBeenCalledWith(context.field)
    expect(context.body.appendChild).not.toHaveBeenCalled()
    expect(context.execCommand).toHaveBeenCalledWith('copy')
    expect(context.field.remove).toHaveBeenCalledOnce()
    expect(context.active.focus).toHaveBeenCalledOnce()
    expect(context.selection.addRange).toHaveBeenCalledWith(context.range)
  })
  it('两种复制方式均不可用时提示手动复制，并清理临时元素', async () => {
    vi.stubGlobal('navigator', {})
    const context = fallbackContext(false)
    await expect(copyReportText('日报内容')).rejects.toThrow('请选中日报内容手动复制')
    expect(context.field.remove).toHaveBeenCalledOnce()
    expect(context.active.focus).toHaveBeenCalledOnce()
  })
})
