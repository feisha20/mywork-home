import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { digest, type Cursor, type SourceMessage } from './records.js'
import { redact } from './redact.js'

interface ZcodeSession { id: string; directory: string; parent_id: string | null }
interface MessageRow { id: string; time_created: number; updated_at: number; data: string }

// 正式会话保存在 SQLite；只读挂载整个目录以读取尚未检查点合并的 WAL。
export class ZcodeReader {
  readonly path: string
  private readonly database: DatabaseSync
  private readonly inode: string

  constructor(directory: string) {
    this.path = join(directory, 'db.sqlite')
    this.inode = String(statSync(this.path).ino)
    this.database = new DatabaseSync(this.path, { readOnly: true })
    this.database.exec('PRAGMA busy_timeout=1000')
  }

  sessions(cutoff: string): ZcodeSession[] {
    return this.database.prepare(`SELECT id,directory,parent_id FROM session
      WHERE EXISTS (SELECT 1 FROM message WHERE session_id=session.id AND time_created>=?)
      ORDER BY id`).all(Date.parse(cutoff)) as unknown as ZcodeSession[]
  }

  cursorPath(session: ZcodeSession): string { return `${this.path}#${encodeURIComponent(session.id)}` }

  readDelta(session: ZcodeSession, previous: Cursor | null, cutoff: string, secrets: string[]) {
    // SQLite 游标保存更新时间，不使用数据库文件大小；写入可能只发生在 WAL。
    let offset = previous?.inode === this.inode ? previous.offset : 0
    const messages: SourceMessage[] = []
    let invalid = 0
    this.database.exec('BEGIN')
    try {
      // 包含边界时间，避免漏掉同一毫秒写入的记录；入库时按稳定消息标识去重。
      const rows = this.database.prepare(`SELECT * FROM (
        SELECT m.id,m.time_created,m.data,max(m.time_updated,coalesce(
          (SELECT max(p.time_updated) FROM part p WHERE p.message_id=m.id),0)) AS updated_at
        FROM message m WHERE m.session_id=? AND m.time_created>=?
      ) WHERE updated_at>=? ORDER BY updated_at,id`).all(session.id, Date.parse(cutoff), offset) as unknown as MessageRow[]
      const parts = this.database.prepare(`SELECT data FROM part WHERE message_id=?
        AND CASE WHEN json_valid(data) THEN json_extract(data,'$.type') END='text'
        ORDER BY time_created,id`)
      for (const row of rows) {
        offset = Math.max(offset, row.updated_at)
        try {
          const data = JSON.parse(row.data)
          if (!['user', 'assistant'].includes(data.role) || data.synthetic || data.summary
            || data.visibility === 'model-only' || data.metadata?.visibility === 'model-only'
            || data.semantics?.uiVisibility === 'hidden' || data.semantics?.transcriptVisibility === 'hidden') continue
          // 流式回复结束后再采集，避免半条回复被提前标为已抽取。
          if (data.role === 'assistant' && !Number.isFinite(data.time?.completed)) continue
          const text = parts.all(row.id).map((part) => JSON.parse(part.data as string))
            .filter((part) => !part.synthetic && !part.ignored && typeof part.text === 'string')
            .map((part) => part.text).join('\n').replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim()
          if (!text || !Number.isFinite(row.time_created)) continue
          messages.push({
            id: digest(`zcode:${session.id}:${row.id}`), source: 'zcode', sessionId: session.id,
            rootSessionId: session.parent_id ?? session.id, projectPath: session.directory,
            role: data.role, timestamp: new Date(row.time_created).toISOString(), text: redact(text, secrets),
          })
        } catch { invalid++ }
      }
      const cursor: Cursor = {
        path: this.cursorPath(session), source: 'zcode', inode: this.inode, offset, modifiedAt: offset,
        context: { sessionId: session.id, projectPath: session.directory, parentSessionId: session.parent_id, turnId: '' },
      }
      return { messages, cursor, invalid }
    } finally { this.database.exec('ROLLBACK') }
  }

  close() { this.database.close() }
}
