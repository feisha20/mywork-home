import { createReadStream } from 'node:fs'
import { opendir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { COLLECTORS, EMPTY_RECORD_MAPPING } from '../shared/settings.js'
import type { RecordMapping, RecordPreview } from '../shared/settings.js'
import { digest, initialContext, normalizeRecord, readDelta, readJsonlDelta } from './records.js'
import type { Cursor, JsonlSource, RecordContext, Source, SourceMessage } from './records.js'
import { readGeminiDelta } from './gemini.js'
import type { GeminiRecordFile } from './gemini.js'
import { redact } from './redact.js'

type Json = Record<string, unknown>
export type CompatibleFormat = JsonlSource | 'gemini' | 'generic'
export interface CompatibleRecordFile extends GeminiRecordFile { format: CompatibleFormat; signature: string }
const excludedNames = /^(?:auth(?:entication)?|credentials?|tokens?|secrets?|settings?|config(?:uration)?|package(?:-lock)?|tsconfig)(?:[._-]|$)/i
const excludedDirectories = new Set(['.git', 'node_modules', '.cache', 'cache', 'checkpoints', 'credentials'])
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
export const compatibleFileName = (name: string) => /\.(?:json|jsonl)$/i.test(name) && !excludedNames.test(name)
export const compatibleDirectoryName = (name: string) => !excludedDirectories.has(name) && !excludedNames.test(name)

export function fieldValue(row: unknown, path: string): unknown {
  let value = row
  for (const key of path.split('.')) {
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Json)[key]
  }
  return value
}
function first(row: unknown, custom: string, aliases: string[]) {
  if (custom) return fieldValue(row, custom)
  for (const key of aliases) { const value = fieldValue(row, key); if (value !== undefined && value !== null) return value }
}
const stringValue = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n')
  if (!isObject(value) || value.thought || value.hidden || value.type && !['text', 'input_text', 'output_text'].includes(String(value.type))) return ''
  return typeof value.text === 'string' ? value.text : Array.isArray(value.parts) ? textValue(value.parts) : ''
}
function visible(row: Json) {
  return !row.isMeta && !row.isCompactSummary && !row.synthetic && row.summary !== true && !row.thought && !row.hidden
    && !['analysis', 'reasoning'].includes(String(row.channel))
    && !['hidden', 'model-only'].includes(String(row.visibility))
    && !['reasoning', 'function_call', 'function_call_result', 'tool_call', 'tool_result', 'tool_use'].includes(String(row.type))
}
function timestampValue(value: unknown) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null
  const time = numeric !== null ? numeric < 100_000_000_000 ? numeric * 1000 : numeric : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null
}

// 字段对应关系只读取 JSON 属性，不执行表达式；时间缺失的消息不会用文件时间补造。
export function normalizeGenericRecords(input: unknown, context: RecordContext, source: Source, mapping = EMPTY_RECORD_MAPPING, secrets: string[] = []) {
  const messages: SourceMessage[] = []
  let invalid = 0, visited = 0
  function visit(value: unknown, inherited: RecordContext, depth: number) {
    if (++visited > 50_000 || depth > 16) throw new Error('会话结构过大或嵌套过深，请拆分导出文件')
    if (Array.isArray(value)) { for (const row of value) visit(row, inherited, depth + 1); return }
    if (!isObject(value) || !visible(value) || isObject(value.message) && !visible(value.message)) return
    const explicitSession = stringValue(first(value, mapping.sessionId, ['sessionId', 'session_id', 'conversationId', 'conversation_id', 'chatId', 'threadId']))
    const sessionId = explicitSession || inherited.sessionId
    const local: RecordContext = { ...inherited, sessionId,
      projectPath: stringValue(first(value, mapping.projectPath, ['projectPath', 'project_path', 'cwd', 'directory', 'project'])) || inherited.projectPath,
      parentSessionId: stringValue(first(value, '', ['parentSessionId', 'parent_session_id', 'parentConversationId'])) || (explicitSession && explicitSession !== inherited.sessionId ? null : inherited.parentSessionId) }
    const nested = first(value, mapping.messages, ['messages', 'conversation', 'records', 'conversations', 'sessions', 'data.messages', 'mapping'])
    if (Array.isArray(nested) || isObject(nested) && (mapping.messages || Object.hasOwn(value, 'mapping'))) {
      local.sessionId = stringValue(first(value, mapping.sessionId, ['sessionId', 'session_id', 'conversationId', 'conversation_id', 'chatId', 'threadId'])) || stringValue(value.id) || inherited.sessionId
      for (const row of Array.isArray(nested) ? nested : Object.values(nested)) visit(row, local, depth + 1)
      return
    }
    const roleValue = stringValue(first(value, mapping.role, ['role', 'speaker', 'author.role', 'message.role', 'message.author.role', 'type'])).toLowerCase()
    const role = ['user', 'human', '用户'].includes(roleValue) ? 'user'
      : ['assistant', 'ai', 'model', 'bot', 'gemini', '助手'].includes(roleValue) ? 'assistant' : null
    if (!role) { if (explicitSession || local.projectPath) { Object.assign(inherited, local); Object.assign(context, local) }; return }
    let text = textValue(first(value, mapping.text, ['content', 'text', 'message.content', 'message.content.parts', 'body', 'message', 'parts']))
      .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').replace(/<cb_summary>[\s\S]*?<\/cb_summary>/g, '')
      .replace(/<image_local_path>[\s\S]*?<\/image_local_path>/g, '').replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1').trim()
    if (!text || role === 'user' && /^(?:# AGENTS\.md instructions|<environment_context>|<system_instruction>)/.test(text)) return
    const timestamp = timestampValue(first(value, mapping.timestamp, ['timestamp', 'createdAt', 'created_at', 'create_time', 'time', 'date', 'message.timestamp', 'message.create_time']))
    if (!timestamp) { invalid++; return }
    const messageId = stringValue(first(value, mapping.messageId, ['id', 'messageId', 'message_id', 'uuid', 'message.id']))
    // 正文版本参与标识，追加、文件移动、重复导入保持去重，修改过的消息可重新提取。
    const id = digest(`generic:${sessionId}:${messageId}:${role}:${timestamp}:${digest(text)}`)
    text = redact(text, secrets)
    messages.push({ id, source, sessionId, rootSessionId: local.parentSessionId ?? sessionId, projectPath: local.projectPath, role, timestamp, text })
    Object.assign(inherited, local); Object.assign(context, local)
  }
  visit(input, { ...context }, 0)
  return { messages, invalid }
}

export function detectRecordFormat(rows: unknown[], mapping = EMPTY_RECORD_MAPPING): CompatibleFormat | null {
  const samples = rows.flatMap((row) => Array.isArray(row) ? row.slice(0, 128) : [row])
  for (const row of samples) {
    if (!isObject(row)) continue
    if (row.type === 'session_meta' && isObject(row.payload) || ['response_item', 'event_msg', 'turn_context'].includes(String(row.type)) && isObject(row.payload)) return 'codex'
    if (['user', 'assistant'].includes(String(row.type)) && isObject(row.message) && (row.uuid || row.sessionId)) return 'claude'
    if (row.type === 'message' && ['user', 'assistant'].includes(String(row.role)) && (row.content !== undefined || row.sessionId)) return 'workbuddy'
    if (row.sessionId && Array.isArray(row.messages) && row.messages.some((message) => isObject(message) && ['user', 'gemini'].includes(String(message.type)))
      || isObject(row.$set) && row.$set.sessionId || row.sessionId && (row.$set || row.$patch || row.$rewindTo)) return 'gemini'
  }
  // Gemini 增量文件首行可能只有会话元信息。
  if (samples.some((row) => isObject(row) && row.sessionId) && samples.some((row) => isObject(row) && row.id && ['user', 'gemini'].includes(String(row.type)) && row.content !== undefined)) return 'gemini'
  for (const row of rows) {
    const context = genericContext('preview.json')
    const normalized = normalizeGenericRecords(row, context, 'custom-preview', mapping)
    if (normalized.messages.length || normalized.invalid) return 'generic'
  }
  return null
}

export async function listCompatibleCandidates(root: string) {
  const files: string[] = []
  let checkedEntries = 0
  async function walk(directory: string, depth: number) {
    if (depth > 32 || files.length >= 10_000) throw new Error('会话目录过大，请选择更具体的目录')
    for await (const entry of await opendir(directory)) {
      if (++checkedEntries > 50_000 || files.length >= 10_000) throw new Error('会话目录过大，请选择更具体的目录')
      if (entry.isDirectory() && compatibleDirectoryName(entry.name)) await walk(join(directory, entry.name), depth + 1)
      else if (entry.isFile() && compatibleFileName(entry.name)) files.push(join(directory, entry.name))
    }
  }
  await walk(root, 0)
  return files.sort()
}
async function boundedText(path: string, bytes: number, strict: boolean) {
  if (strict && (await stat(path)).size > bytes) throw new Error('JSON 文件超过 8 MB，请拆分或改用 JSONL')
  const chunks: Buffer[] = []
  const stream = createReadStream(path, { end: bytes - 1 })
  try { for await (const chunk of stream) chunks.push(chunk as Buffer) } finally { stream.destroy() }
  return Buffer.concat(chunks).toString('utf8')
}
async function sampleRows(path: string) {
  if (/\.json$/i.test(path)) return [JSON.parse(await boundedText(path, 8 * 1024 * 1024, true)) as unknown]
  const raw = await boundedText(path, 256 * 1024, false)
  const rows: unknown[] = []
  for (const line of raw.split('\n').slice(0, 128)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 采样中的半行和损坏行留给正式增量读取处理。 */ }
  }
  return rows
}
function genericContext(path: string): RecordContext {
  const name = basename(path).replace(/\.(?:json|jsonl)$/i, '')
  return { sessionId: /^(?:messages?|conversations?|records?|chat|history)$/i.test(name) ? `${basename(dirname(path))}:${name}` : name,
    projectPath: '', parentSessionId: null, turnId: '' }
}
export function recordReaderSignature(format: CompatibleFormat, mapping?: RecordMapping) { return digest(JSON.stringify({ version: 1, format, mapping: mapping ?? EMPTY_RECORD_MAPPING })) }

export async function classifyCompatibleFile(path: string, mode: 'auto' | 'generic', mapping?: RecordMapping): Promise<CompatibleRecordFile | null> {
  const rows = await sampleRows(path)
  const format = mode === 'generic' ? 'generic' : detectRecordFormat(rows, mapping)
  if (!format) return null
  let projectPath = '', parentSessionId: string | null = null
  if (format === 'gemini') {
    const parts = path.split('/chats/')
    if (parts.length === 2) {
      projectPath = (await readFile(join(parts[0], '.project_root'), 'utf8').catch(() => '')).trim()
      const nested = parts[1].split('/')
      parentSessionId = nested.length > 1 ? nested[0] : null
    }
  }
  return { path, format, projectPath, parentSessionId, signature: recordReaderSignature(format, mapping) }
}

export async function readCompatibleDelta(file: CompatibleRecordFile, source: Source, previous: Cursor | null, cutoff: string, secrets: string[], mapping?: RecordMapping, preview = false) {
  const cursor = previous?.context.readerSignature === file.signature ? previous : null
  let delta
  if (file.format === 'gemini') delta = await readGeminiDelta(file, cursor, cutoff, secrets, preview ? (/\.json$/i.test(file.path) ? 8 : 2) * 1024 * 1024 : undefined)
  else if (file.format !== 'generic' && /\.jsonl$/i.test(file.path)) delta = await readDelta(file.path, file.format, cursor, cutoff, secrets)
  else if (/\.jsonl$/i.test(file.path)) delta = await readJsonlDelta(file.path, source, cursor, cutoff, () => genericContext(file.path),
    (row, context) => normalizeGenericRecords(row, context, source, mapping, secrets))
  else {
    const info = await stat(file.path), raw = JSON.parse(await boundedText(file.path, 8 * 1024 * 1024, true)) as unknown
    const context = file.format === 'generic' ? genericContext(file.path) : initialContext(file.path, file.format)
    let normalized
    if (file.format === 'generic') normalized = normalizeGenericRecords(raw, context, source, mapping, secrets)
    else {
      const rows = Array.isArray(raw) ? raw : [raw], messages: SourceMessage[] = []
      for (const row of rows) if (isObject(row)) { const message = normalizeRecord(row, file.format, context, secrets); if (message) messages.push(message) }
      normalized = { messages, invalid: 0 }
    }
    delta = { ...normalized, messages: normalized.messages.filter((message) => message.timestamp >= cutoff),
      cursor: { path: file.path, source, inode: String(info.ino), offset: info.size, context, modifiedAt: Math.trunc(info.mtimeMs) }, blocked: false, more: false }
  }
  delta.cursor.context.readerSignature = file.signature
  return delta
}

// 仅识别已经接入的数据库表结构；其他 SQLite 不猜测正文所在的表。
export function isCompatibleDatabase(root: string) {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(join(root, 'db.sqlite'), { readOnly: true })
    const tables: Record<string, string[]> = { session: ['id', 'directory', 'parent_id'], message: ['id', 'session_id', 'time_created', 'time_updated', 'data'], part: ['id', 'message_id', 'time_created', 'time_updated', 'data'] }
    return Object.entries(tables).every(([table, required]) => {
      const columns = database!.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name))
      return required.every((column) => columns.includes(column))
    })
  } catch { return false } finally { database?.close() }
}

export async function previewCompatibleRecords(roots: string[], mode: 'auto' | 'generic', mapping: RecordMapping | undefined, secrets: string[]): Promise<RecordPreview> {
  const preview: RecordPreview = { formats: [], checkedFiles: 0, compatibleFiles: 0, messages: [], issues: [] }
  const formats = new Set<string>(), issues = new Set<string>()
  for (const root of roots) {
    if (preview.checkedFiles >= 8) { issues.add('本次只检查前 8 个文件，正式采集会继续读取其他文件'); break }
    if (mode === 'auto' && isCompatibleDatabase(root)) { formats.add(COLLECTORS.zcode); preview.checkedFiles++; preview.compatibleFiles++; issues.add('已识别会话数据库，正式采集使用对应数据库读取器'); continue }
    let candidates: string[]
    try { candidates = await listCompatibleCandidates(root) }
    catch { issues.add('目录无法读取或范围过大，请选择具体的会话目录'); continue }
    for (const path of candidates.slice(0, Math.max(0, 8 - preview.checkedFiles))) {
      preview.checkedFiles++
      try {
        const file = await classifyCompatibleFile(path, mode, mapping)
        if (!file) { issues.add('部分文件尚未识别，请选择通用格式并配置角色、正文和时间字段'); continue }
        const delta = await readCompatibleDelta(file, 'custom-preview', null, '0001-01-01T00:00:00.000Z', secrets, mapping, true)
        if (delta.invalid) issues.add('部分记录缺少有效时间、字段不匹配或内容损坏，请检查字段对应关系')
        if (delta.more) issues.add('大文件只预览开头的记录，正式采集会继续读取后续内容')
        if (!delta.messages.length) { issues.add(delta.invalid ? '部分记录缺少有效时间或字段不匹配，请检查字段对应关系' : '部分文件未找到可见的用户或助手消息'); continue }
        formats.add(COLLECTORS[file.format]); preview.compatibleFiles++
        for (const message of delta.messages.slice(0, Math.max(0, 3 - preview.messages.length))) preview.messages.push({ role: message.role, timestamp: message.timestamp, text: message.text.slice(0, 240) })
      } catch { issues.add('部分文件无法解析、仍在写入或超过大小限制，请检查导出文件') }
    }
    if (candidates.length > 8) issues.add('本次只检查前 8 个文件，正式采集会继续读取其他文件')
  }
  preview.formats = [...formats]; preview.issues = [...issues]
  if (!preview.checkedFiles && !formats.size) preview.issues.push('未找到可检查的 JSON、JSONL 或已支持的会话数据库；其他数据库需导出为 JSON 或另行适配')
  return preview
}
