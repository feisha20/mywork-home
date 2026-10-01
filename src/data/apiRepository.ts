import type { Task } from '../domain/workbench'
import { decodeSnapshot } from '../domain/workbench'
import type { SyncRun, WorkbenchSnapshot } from '../../shared/contracts'

const storageKey = 'mywork-home.workbench.v1'
const migrationKey = `${storageKey}.migrated`
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) }) }
  catch { throw new Error('无法连接工作台服务，请确认后端已启动') }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? '请求失败，请稍后重试')
  return body as T
}
export async function fetchWorkbench() {
  const snapshot = await request<WorkbenchSnapshot>('/workbench')
  if (!snapshot || !decodeSnapshot(JSON.stringify(snapshot)) || !snapshot.harness || !snapshot.sources) throw new Error('服务返回的数据无法读取')
  return snapshot
}
export const createTask = (title: string) => request<Task>('/tasks', { method: 'POST', body: JSON.stringify({ title }) })
export const updateTask = (id: string, completed: boolean) => request<Task>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ completed }) })
export const deleteTask = (id: string) => request<{ deleted: boolean }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' })
export const startSync = () => request<SyncRun>('/sync', { method: 'POST', body: '{}' })

// 不调用旧 loadWorkbench，避免把损坏缓存回退产生的示例导入数据库。
export async function migrateLegacyTasks(): Promise<string | null> {
  let raw: string | null
  try { if (localStorage.getItem(migrationKey)) return null; raw = localStorage.getItem(storageKey) }
  catch { return '浏览器旧缓存无法读取，数据库功能仍可使用。' }
  if (!raw) return null
  const state = decodeSnapshot(raw)
  if (!state) return '旧缓存格式无效，原记录已保留，请检查后再迁移。'
  const tasks = state.tasks.filter((task) => task.source === 'manual' && !task.id.startsWith('demo-'))
  if (tasks.length) await request('/tasks/import', { method: 'POST', body: JSON.stringify({ tasks }) })
  try { localStorage.setItem(migrationKey, new Date().toISOString()) }
  catch { return '旧事项已迁移，浏览器无法保存迁移标记；再次迁移不会重复新增。' }
  return tasks.length ? `已将 ${tasks.length} 项手工记录迁移到数据库。` : null
}
