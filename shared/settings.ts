import { z } from 'zod'
import type { SourceId } from '../src/domain/workbench.js'

export const COLLECTORS = {
  auto: '自动识别（推荐）', generic: '通用 JSON / JSONL',
  codex: 'Codex 会话', claude: 'Claude Code 会话', workbuddy: 'WorkBuddy 会话',
  zcode: 'Zcode 数据库', gemini: 'Gemini CLI 会话', none: '暂不接入采集',
} as const
export type CollectorKind = keyof typeof COLLECTORS
export type ChannelId = Exclude<SourceId, 'manual'>
export interface RecordMapping {
  messages: string
  role: string
  text: string
  timestamp: string
  sessionId: string
  messageId: string
  projectPath: string
}
export const EMPTY_RECORD_MAPPING: RecordMapping = { messages: '', role: '', text: '', timestamp: '', sessionId: '', messageId: '', projectPath: '' }
export interface ChannelConfig {
  id: ChannelId
  name: string
  logo: string
  collector: CollectorKind
  enabled: boolean
  pathMode: 'scan' | 'manual'
  paths: string[]
  mapping?: RecordMapping
}
export type ChannelSummary = Omit<ChannelConfig, 'paths' | 'pathMode' | 'mapping'>
export interface WorkbenchSettings {
  revision: number
  model: { baseUrl: string; name: string; hasApiKey: boolean }
  sync: { enabled: boolean; intervalMs: number }
  channels: ChannelConfig[]
  pathEnvironment: 'local' | 'container'
  unresolvedPaths?: string[]
}
export interface PathScanResult { paths: string[]; checked: number; message: string; unresolvedPaths?: string[] }
export interface SourcePathCheck {
  inputPath: string
  path: string
  hostPath: string | null
  containerPath: string | null
  readOnly: boolean | null
  status: 'ready' | 'empty' | 'missing' | 'unreadable' | 'unmounted'
  recordFiles: number
  limited: boolean
  message: string
}
export interface PathCheckResult { environment: WorkbenchSettings['pathEnvironment']; paths: SourcePathCheck[] }
export interface RecordPreview {
  formats: string[]
  checkedFiles: number
  compatibleFiles: number
  messages: { role: 'user' | 'assistant'; timestamp: string; text: string }[]
  issues: string[]
}

export const builtinCollectors = { zentao: 'none', claude: 'claude', codex: 'codex', workbuddy: 'workbuddy', zcode: 'zcode', gemini: 'gemini' } as const
const channelId = z.string().regex(/^(?:zentao|claude|codex|workbuddy|zcode|gemini|custom-[a-z0-9-]{1,64})$/, '渠道标识无效')
const logo = z.string().max(349_551, 'Logo 不能超过 256 KB').refine((value) => !value
  || /^\/channels\/[a-zA-Z0-9._-]+\.(?:png|jpe?g|svg|webp)$/.test(value)
  || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value), '请上传 PNG、JPEG 或 WebP 图片')
export const sourcePathSchema = z.string().trim().min(1).max(4096).refine((path) => (path.startsWith('/') || path.startsWith('~/')) && !/[\r\n\0]/.test(path), '请填写绝对目录或 ~/ 开头的目录')
export const collectorSchema = z.enum(['auto', 'generic', 'codex', 'claude', 'workbuddy', 'zcode', 'gemini', 'none'])
const fieldPath = z.string().trim().max(160, '字段名不能超过 160 个字符').refine((path) => !path || /^[\p{L}\p{N}_$-]+(?:\.[\p{L}\p{N}_$-]+)*$/u.test(path) && !path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)), '请填写字段名或点分隔的嵌套字段，例如 message.content')
export const recordMappingSchema = z.object({ messages: fieldPath, role: fieldPath, text: fieldPath, timestamp: fieldPath,
  sessionId: fieldPath, messageId: fieldPath, projectPath: fieldPath })
export const pathCheckSchema = z.object({
  collector: collectorSchema,
  paths: z.array(sourcePathSchema).max(10, '每个渠道最多配置 10 个目录'),
})
export const recordPreviewSchema = pathCheckSchema.extend({ mapping: recordMappingSchema.optional() })
export const modelSettingsSchema = z.object({
  baseUrl: z.string().trim().max(2048).url('模型地址格式无效').refine((value) => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, '请填写不含密钥、查询参数的 HTTP 或 HTTPS 基础地址'),
  name: z.string().trim().min(1, '请填写模型名称').max(160),
  apiKey: z.string().trim().max(4096).optional(),
  clearApiKey: z.boolean().optional(),
}).refine((model) => !(model.clearApiKey && model.apiKey), '清除密钥时不能同时填写新密钥')
export const channelSettingsSchema = z.object({
  id: channelId,
  name: z.string().trim().min(1, '请填写渠道名称').max(40), logo,
  collector: collectorSchema,
  enabled: z.boolean(), pathMode: z.enum(['scan', 'manual']),
  paths: z.array(sourcePathSchema).max(10, '每个渠道最多配置 10 个目录'),
  mapping: recordMappingSchema.optional(),
}).refine((channel) => channel.collector === 'none' || !channel.enabled || channel.paths.length > 0, '启用采集前，请扫描或填写至少一个目录')
export const settingsUpdateSchema = z.object({
  revision: z.number().int().min(1), model: modelSettingsSchema,
  sync: z.object({ enabled: z.boolean(), intervalMs: z.number().int().min(60_000).max(86_400_000) }),
  channels: z.array(channelSettingsSchema).min(6).max(30),
}).superRefine(({ channels }, context) => {
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length) context.addIssue({ code: 'custom', message: '渠道标识不能重复' })
  for (const [id, collector] of Object.entries(builtinCollectors)) {
    const channel = channels.find((entry) => entry.id === id)
    if (!channel || channel.collector !== collector) context.addIssue({ code: 'custom', message: '内置渠道请保留原记录格式，可通过开关停用' })
  }
})
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>
