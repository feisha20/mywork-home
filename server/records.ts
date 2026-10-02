import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { redact } from './redact.js'
import type { SessionSource } from '../shared/contracts.js'

export type Source = SessionSource
export type JsonlSource = Exclude<Source, 'zcode' | 'gemini'>
export interface RecordContext { sessionId: string; projectPath: string; parentSessionId: string | null; turnId: string }
export interface Cursor { path: string; source: Source; inode: string; offset: number; context: RecordContext; modifiedAt: number }
export interface SourceMessage {
  id: string; source: Source; sessionId: string; rootSessionId: string;
  projectPath: string; role: 'user' | 'assistant'; timestamp: string; text: string
}
type Json = Record<string, any>
export function digest(input: string) { return createHash('sha256').update(input).digest('hex') }

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block && ['text', 'input_text', 'output_text'].includes(block.type)).map((block) => block.text ?? '').join('\n')
}

export function initialContext(path: string, source: JsonlSource): RecordContext {
  const ids = basename(path).match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi)
  return {
    sessionId: source === 'codex' ? ids?.[0] ?? basename(path, '.jsonl') : basename(path, '.jsonl'),
    projectPath: '',
    parentSessionId: (source === 'claude' || source === 'workbuddy') && basename(dirname(path)) === 'subagents' ? basename(dirname(dirname(path))) : null,
    turnId: '',
  }
}

// 仅提取用户与助手文字，不把工具返回值当作用户要求。
export function normalizeRecord(row: Json, source: JsonlSource, context: RecordContext, secrets: string[] = []): SourceMessage | null {
  const payload = row.payload ?? {}
  if (source === 'codex') {
    if (row.type === 'session_meta') {
      context.sessionId = payload.id ?? payload.session_id ?? context.sessionId
      context.projectPath = payload.cwd ?? context.projectPath
      context.parentSessionId = payload.parent_thread_id ?? payload.forked_from_id ?? payload.source?.subagent?.thread_spawn?.parent_thread_id ?? null
    }
    if (row.type === 'turn_context') {
      context.turnId = payload.turn_id ?? context.turnId
      context.projectPath = payload.cwd ?? context.projectPath
    }
    if (row.type === 'event_msg' && payload.type === 'task_started') context.turnId = payload.turn_id ?? context.turnId
  } else {
    context.sessionId = row.sessionId ?? context.sessionId
    context.projectPath = row.cwd ?? context.projectPath
  }
  let role: 'user' | 'assistant'
  let text = ''
  let eventId = ''
  if (source === 'codex') {
    if (row.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
      if (payload.role === 'assistant' && ['analysis', 'reasoning'].includes(payload.channel)) return null
      role = payload.role; text = textContent(payload.content)
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message', 'task_complete'].includes(payload.type)) {
      role = payload.type === 'user_message' ? 'user' : 'assistant'
      text = textContent(payload.message ?? payload.last_agent_message)
    } else if (row.type === 'event_msg' && payload.item?.type === 'AgentMessage') {
      role = 'assistant'; text = textContent(payload.item.text ?? payload.item.content)
    } else return null
    eventId = `${context.turnId || row.timestamp}:${role}:${digest(text)}`
  } else if (source === 'claude') {
    if (!['user', 'assistant'].includes(row.type) || row.isMeta || row.isCompactSummary) return null
    role = row.type; text = textContent(row.message?.content)
    eventId = row.uuid ?? row.message?.id ?? `${row.timestamp}:${digest(text)}`
  } else {
    if (row.type !== 'message' || !['user', 'assistant'].includes(row.role)) return null
    role = row.role; text = textContent(row.content)
    eventId = row.id ?? row.uuid ?? `${row.timestamp}:${digest(text)}`
  }
  const parsedTime = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp)
  if (!text.trim() || !Number.isFinite(parsedTime)) return null
  if (role === 'user' && /^(?:# AGENTS\.md instructions|<environment_context>|<external_codex_apps_open_page>|<send_user_message_question_reply>)/.test(text.trim())) return null
  text = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
  if (source === 'workbuddy') {
    text = text.replace(/<cb_summary>[\s\S]*?<\/cb_summary>/g, '')
    text = text.replace(/<image_local_path>[\s\S]*?<\/image_local_path>/g, '')
    text = text.replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1')
  }
  text = text.trim()
  if (!text) return null
  const safe = redact(text, secrets)
  return {
    id: digest(`${source}:${context.sessionId}:${eventId}`), source, sessionId: context.sessionId,
    rootSessionId: context.parentSessionId ?? context.sessionId, projectPath: context.projectPath,
    role, timestamp: new Date(parsedTime).toISOString(), text: safe,
  }
}

export function isSkippableRecordLine(line: Buffer, source: JsonlSource): boolean {
  if (source === 'workbuddy') {
    return line.includes('"type":"function_call') || line.includes('"type": "function_call')
      || line.includes('"type":"reasoning"') || line.includes('"type": "reasoning"')
      || line.includes('"type":"file-history-snapshot"') || line.includes('"type": "file-history-snapshot"')
      || line.includes('"type":"ai-title"') || line.includes('"type": "ai-title"')
  }
  if (source === 'claude') {
    return line.includes('"isMeta":true') || line.includes('"isMeta": true')
      || line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')
  }
  return line.includes('"channel":"analysis"') || line.includes('"channel":"reasoning"')
}

export async function listRecordFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listRecordFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
  }
  return files.sort()
}

// 字节游标只越过完整行；末尾半行留到下次，不会截断 UTF-8 字符。
export async function readDelta(path: string, source: JsonlSource, previous: Cursor | null, cutoff: string, secrets: string[]) {
  const info = await stat(path)
  const inode = String(info.ino)
  const reset = !previous || previous.inode !== inode || info.size < previous.offset || (previous.modifiedAt !== Math.trunc(info.mtimeMs) && info.size === previous.offset)
  let offset = reset ? 0 : previous.offset
  const context = reset ? initialContext(path, source) : { ...previous.context }
  const messages: SourceMessage[] = []
  let pending: Buffer = Buffer.alloc(0), consumed = 0, lines = 0, invalid = 0, dropping = false, droppedBytes = 0
  const stream = createReadStream(path, { start: offset, highWaterMark: 64 * 1024 })
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk as Buffer])
      let newline: number
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        offset += droppedBytes + newline + 1; consumed += droppedBytes + newline + 1; lines++
        droppedBytes = 0
        if (dropping) { dropping = false; continue }
        if (!line.length) continue
        if (isSkippableRecordLine(line, source)) continue
        try {
          const message = normalizeRecord(JSON.parse(line.toString('utf8')), source, context, secrets)
          if (message && message.timestamp >= cutoff) messages.push(message)
        } catch { invalid++ }
      }
      if (pending.length > 4 * 1024 * 1024) {
        // 超大的工具日志行无需保存在内存中，但游标仍等待换行后才能提交。
        if (!dropping) invalid++
        dropping = true; droppedBytes += pending.length
        // 不提交半行：发生中断时从该行起点重读。
        pending = Buffer.alloc(0)
      }
      if (!dropping && (consumed >= 2 * 1024 * 1024 || lines >= 2000)) break
    }
  } finally { stream.destroy() }
  const cursor: Cursor = { path, source, inode, offset, context, modifiedAt: Math.trunc(info.mtimeMs) }
  return { messages, cursor, invalid, blocked: dropping, more: !dropping && offset < info.size && lines > 0 && (consumed >= 2 * 1024 * 1024 || lines >= 2000) }
}

// 内容无法入库可按坏日志限次重试；连接、事务及数据库故障仍保留原进度。
export function isRecordDataError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return false
  return /^22[A-Z0-9]{3}$/.test(error.code) || error.code === '23502'
}
