import type { WorkbenchSnapshot } from './contracts.js'
import type { ModelRuntimeStatus } from './settings.js'

// 事件只传界面所需的状态与摘要，不包含密钥、路径、原始会话或来源证据。
export interface WorkbenchEvents {
  'sync:progress': { harness: WorkbenchSnapshot['harness']; modelRuntime: ModelRuntimeStatus }
  'model:failover': { from: string; to: string; modelRuntime: ModelRuntimeStatus; harness: WorkbenchSnapshot['harness'] }
  'model:changed': { modelRuntime: ModelRuntimeStatus; harness: WorkbenchSnapshot['harness'] }
  'tasks:created': { tasks: { id: string; reference: string; title: string; source: string }[] }
  'workbench:changed': { dataVersion: string }
}
export type WorkbenchEventName = keyof WorkbenchEvents
