export async function copyReportText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return }
    catch { /* 剪贴板权限受限时，继续尝试本机浏览器的复制兼容方式。 */ }
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;'
  // 原生模态窗口之外的元素不可聚焦，兼容复制框应放进当前打开的窗口。
  const container = document.querySelector('dialog[open]') ?? document.body
  container.appendChild(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('复制未成功')
  } catch {
    throw new Error('复制失败，请选中日报内容手动复制')
  } finally {
    field.remove()
    if (active?.isConnected) active.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); ranges.forEach((range) => selection.addRange(range)) }
  }
}
