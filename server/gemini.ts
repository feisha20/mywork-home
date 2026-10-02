import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digest, type Cursor, type SourceMessage } from './records.js'
import { redact } from './redact.js'

type Json = Record<string, any>
export interface GeminiRecordFile { path: string; projectPath: string; parentSessionId: string | null }

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return isObject(content) && !content.thought && typeof content.text === 'string' ? content.text : ''
  return content.map((part) => typeof part === 'string' ? part
    : isObject(part) && !part.thought && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
}

// 只遍历 tmp 下每个项目的 chats；不扫描认证、设置、工具输出或检查点目录。
export async function listGeminiRecordFiles(root: string): Promise<GeminiRecordFile[]> {
  const files: GeminiRecordFile[] = []
  async function chats(directory: string, projectPath: string, parentSessionId: string | null) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await chats(path, projectPath, parentSessionId ?? entry.name)
      else if (entry.isFile() && /\.(?:json|jsonl)$/.test(entry.name)
        && (entry.name.startsWith('session-') || parentSessionId)) files.push({ path, projectPath, parentSessionId })
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const project = join(root, entry.name)
    let projectPath = ''
    try { projectPath = (await readFile(join(project, '.project_root'), 'utf8')).trim() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await chats(join(project, 'chats'), projectPath, null)
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// 文件变化时重建可见历史，避免把 $set 快照、回退记录或补丁直接当成新消息。
export async function readGeminiDelta(file: GeminiRecordFile, previous: Cursor | null, cutoff: string, secrets: string[], maxBytes?: number) {
  const info = await stat(file.path)
  const readSize = Math.min(info.size, maxBytes ?? info.size)
  if (previous?.inode === String(info.ino) && previous.offset === info.size && previous.modifiedAt === Math.trunc(info.mtimeMs)) {
    return { messages: [] as SourceMessage[], cursor: previous, invalid: 0, blocked: false, more: false }
  }
  let metadata: Json = {}
  const history = new Map<string, Json>()
  let invalid = 0, offset = 0, blocked = false
  const add = (row: unknown) => { if (isObject(row) && typeof row.id === 'string') history.set(row.id, row) }
  const patchMessage = (patch: Json) => {
    const row = history.get(patch.id)
    if (row && Object.hasOwn(patch, 'content')) history.set(patch.id, { ...row, content: patch.content })
    // 工具补丁仅修改执行结果，不参与工作正文抽取。
  }
  const applyRecord = (row: Json) => {
    if (typeof row.$rewindTo === 'string') {
      const ids = [...history.keys()], index = ids.indexOf(row.$rewindTo)
      if (index >= 0) { for (const id of ids.slice(index)) history.delete(id) }
      else history.clear()
    } else if (isObject(row.$patch)) {
      const patch = row.$patch
      patchMessage(patch)
      if (Array.isArray(patch.updates)) for (const update of patch.updates) if (isObject(update)) patchMessage(update)
      if (Array.isArray(patch.removeIds)) for (const id of patch.removeIds) history.delete(id)
      if (Array.isArray(patch.orderIds)) {
        const ordered = patch.orderIds.filter((id: unknown) => typeof id === 'string' && history.has(id)) as string[]
        const entries = ordered.map((id) => [id, history.get(id)!] as const)
        for (const id of ordered) history.delete(id)
        for (const [id, message] of entries) history.set(id, message)
      }
    } else if (isObject(row.$set)) {
      const { messages, ...updates } = row.$set
      metadata = { ...metadata, ...updates }
      if (Array.isArray(messages)) { history.clear(); for (const message of messages) add(message) }
    } else if (typeof row.sessionId === 'string') {
      const { messages, ...updates } = row
      metadata = { ...metadata, ...updates }
      if (Array.isArray(messages)) for (const message of messages) add(message)
    } else add(row)
  }
  if (file.path.endsWith('.json')) {
    // 兼容旧版完整 JSON；尚未写完或读取失败时不提交游标。
    if (info.size > readSize) throw new Error('会话快照超过预览范围，请选择较小的样本文件')
    const row: unknown = JSON.parse(await readFile(file.path, 'utf8'))
    if (!isObject(row)) throw new Error('Gemini 会话格式无效')
    applyRecord(row); offset = info.size
  } else {
    let pending: Buffer = Buffer.alloc(0), droppedBytes = 0, dropping = false
    const stream = createReadStream(file.path, { highWaterMark: 64 * 1024, end: Math.max(0, readSize - 1) })
    try {
      for await (const chunk of stream) {
        pending = Buffer.concat([pending, chunk as Buffer])
        let newline: number
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline)
          pending = pending.subarray(newline + 1)
          offset += droppedBytes + newline + 1; droppedBytes = 0
          if (dropping) { dropping = false; continue }
          if (!line.length) continue
          try {
            const row: unknown = JSON.parse(line.toString('utf8'))
            if (isObject(row)) applyRecord(row); else invalid++
          } catch { invalid++ }
        }
        if (pending.length > 4 * 1024 * 1024) {
          if (!dropping) invalid++
          dropping = true; droppedBytes += pending.length; pending = Buffer.alloc(0)
        }
      }
      // 半行等待下次追加，不提前抽取未写完的回复。
      blocked = dropping
    } finally { stream.destroy() }
  }
  if (typeof metadata.sessionId !== 'string' || !metadata.sessionId) throw new Error('Gemini 会话缺少有效元信息')
  const sessionId = metadata.sessionId
  const projectPath = file.projectPath || (typeof metadata.cwd === 'string' ? metadata.cwd : '')
  const messages: SourceMessage[] = []
  for (const row of history.values()) {
    if (!['user', 'gemini'].includes(row.type) || row.isMeta || row.isCompactSummary || row.synthetic) continue
    const time = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp)
    if (!Number.isFinite(time)) { invalid++; continue }
    const timestamp = new Date(time).toISOString()
    if (timestamp < cutoff) continue
    // 用户显示正文优先，避免把附件展开或注入的目录上下文当成用户要求。
    let text = textContent(row.type === 'user' ? row.displayContent ?? row.content : row.content)
      .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim()
    if (!text || /^(?:# AGENTS\.md instructions|<environment_context>|<system_instruction>|<system-reminder>)/.test(text)) continue
    text = redact(text, secrets)
    const role = row.type === 'user' ? 'user' : 'assistant'
    messages.push({
      // 同一正文的快照/迁移保持同 ID；正文补丁按内容版本采集，避免遗漏后续回复。
      id: digest(`gemini:${sessionId}:${row.id}:${role}:${digest(text)}`), source: 'gemini', sessionId,
      rootSessionId: file.parentSessionId ?? sessionId, projectPath, role, timestamp, text,
    })
  }
  const cursor: Cursor = {
    path: file.path, source: 'gemini', inode: String(info.ino), offset, modifiedAt: Math.trunc(info.mtimeMs),
    context: { sessionId, projectPath, parentSessionId: file.parentSessionId, turnId: '' },
  }
  return { messages, cursor, invalid, blocked, more: info.size > readSize }
}
