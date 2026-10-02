import type { Task } from '../domain/workbench'
import { decodeSnapshot } from '../domain/workbench'
import type { DailyReport, SyncRun, WorkbenchSnapshot } from '../../shared/contracts'
import type { CollectorKind, PathCheckResult, PathScanResult, SettingsUpdate, WorkbenchSettings } from '../../shared/settings'

const storageKey = 'mywork-home.workbench.v1'
const migrationKey = `${storageKey}.migrated`
async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  let response: Response
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try { response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal }) }
  catch {
    if (options.signal?.aborted) throw options.signal.reason
    if (timeout.aborted) throw new Error('请求超时，请稍后重试')
    throw new Error('无法连接工作台服务，请确认后端已启动')
  }
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
export const fetchSettings = (signal?: AbortSignal) => request<WorkbenchSettings>('/settings', { signal, cache: 'no-store' })
export const saveSettings = (settings: SettingsUpdate) => request<WorkbenchSettings>('/settings', { method: 'PUT', body: JSON.stringify(settings) })
export const scanChannelPaths = (collector: CollectorKind) => request<PathScanResult>('/settings/scan', { method: 'POST', body: JSON.stringify({ collector }) })
export const checkChannelPaths = (collector: CollectorKind, paths: string[], signal?: AbortSignal) => request<PathCheckResult>('/settings/check-paths', { method: 'POST', body: JSON.stringify({ collector, paths }), signal })
export const testModelConnection = (model: SettingsUpdate['model']) => request<{ message: string }>('/settings/test-model', { method: 'POST', body: JSON.stringify(model) }, 20000)
// 模型总结需要比普通数据请求更长的等待时间；关闭预览时可取消前端等待。
export const generateDailyReport = (day: string, signal?: AbortSignal, mode: 'initial' | 'append' = 'initial') => request<DailyReport>('/daily-reports',
  { method: 'POST', body: JSON.stringify(mode === 'initial' ? { day } : { day, mode }), signal }, 240000)
export const fetchDailyReport = (day: string, signal?: AbortSignal) => request<DailyReport | null>(`/daily-reports/${encodeURIComponent(day)}`, { signal })
export async function loadOrCreateDailyReport(day: string, signal?: AbortSignal): Promise<DailyReport> {
  const saved = await fetchDailyReport(day, signal)
  if (saved) return saved
  return generateDailyReport(day, signal)
}

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
