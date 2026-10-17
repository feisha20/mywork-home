import { createContext } from 'react'
import type { ModelUsage } from '../../shared/modelUsage'

// 模型状态与工作台共用一条 SSE，弹窗无需额外建立连接或高频轮询。
export const RealtimeModelContext = createContext<{ connected: boolean; usage?: ModelUsage }>({ connected: false })
