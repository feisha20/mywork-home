import { createDemoState, decodeSnapshot } from '../domain/workbench'
import type { WorkbenchState } from '../domain/workbench'

const STORAGE_KEY = 'mywork-home.workbench.v1'

// 页面通过这一层读写数据，后续可以替换为 Tauri 或本机服务。
export function loadWorkbench(now: Date): { state: WorkbenchState; notice: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const state = decodeSnapshot(raw)
      if (state) return { state, notice: null }
      localStorage.setItem(`${STORAGE_KEY}.backup`, raw)
      return { state: createDemoState(now), notice: '原本机记录无法读取，已保留备份并载入示例。' }
    }
    return { state: createDemoState(now), notice: null }
  } catch {
    return { state: createDemoState(now), notice: '本机存储暂不可用，本次操作将保留在页面中。' }
  }
}

export function saveWorkbench(state: WorkbenchState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}
