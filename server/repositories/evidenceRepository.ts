import type { Pool, PoolClient } from 'pg'
import { requiresManualCompletion, type Task } from '../../src/domain/workbench.js'
import type { Evidence } from '../../shared/contracts.js'
import { digest, type Cursor, type SourceMessage } from '../records.js'
import { taskFromRow, withTransaction, type ExtractedItem } from './db.js'

export class EvidenceRepository {
  constructor(
    private readonly pool: Pool,
    private readonly onClassificationChanges?: (client: PoolClient, tasks: Task[]) => Promise<void>,
  ) {}

  batchId(messages: SourceMessage[]): string {
    return digest(`v2:${messages.map((message) => `${message.id}:${message.bodyRevision ?? 1}:${digest(message.text)}`).join(':')}`)
  }

  async ingest(messages: SourceMessage[], cursor: Cursor, reconcile = false): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      let inserted = 0
      const editedIds = new Set<string>(), withdrawnIds = new Set<string>()
      const sessionKey = `${cursor.source}:${cursor.context.sessionId}`
      await client.query(`INSERT INTO workbench.source_sessions(id,source,session_id,project_path,parent_session_id,updated_at)
        VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path,parent_session_id=excluded.parent_session_id,updated_at=now()`,
      [sessionKey, cursor.source, cursor.context.sessionId, cursor.context.projectPath, cursor.context.parentSessionId])
      for (const message of messages) {
        const key = `${message.source}:${message.sessionId}`
        if (key !== sessionKey) await client.query(`INSERT INTO workbench.source_sessions(id,source,session_id,project_path,parent_session_id,updated_at)
          VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO UPDATE SET
          project_path=excluded.project_path,parent_session_id=excluded.parent_session_id,updated_at=now()`,
        [key, message.source, message.sessionId, message.projectPath, message.rootSessionId === message.sessionId ? null : message.rootSessionId])
        const existing = await client.query('SELECT body,body_revision,valid FROM workbench.source_messages WHERE id=$1 FOR UPDATE', [message.id])
        if (existing.rows[0] && existing.rows[0].body !== message.text) editedIds.add(message.id)
        if (message.originKey) {
          const replaced = await client.query(`UPDATE workbench.source_messages SET valid=false,invalid_reason='edited'
            WHERE source=$1 AND session_id=$2 AND origin_key=$3 AND id<>$4 AND valid RETURNING id`,
          [message.source, message.sessionId, message.originKey, message.id])
          for (const row of replaced.rows) editedIds.add(row.id)
        }
        const result = await client.query(`INSERT INTO workbench.source_messages(id,session_key,source,session_id,root_session_id,project_path,role,occurred_at,body,origin_key,source_path)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET
          body=excluded.body,origin_key=excluded.origin_key,source_path=excluded.source_path,
          body_revision=workbench.source_messages.body_revision+CASE WHEN workbench.source_messages.body<>excluded.body OR NOT workbench.source_messages.valid THEN 1 ELSE 0 END,
          extracted=CASE WHEN workbench.source_messages.body<>excluded.body OR NOT workbench.source_messages.valid THEN false ELSE workbench.source_messages.extracted END,
          valid=true,invalid_reason=NULL
          RETURNING body_revision`,
        [message.id, key, message.source, message.sessionId, message.rootSessionId, message.projectPath, message.role, message.timestamp, message.text, message.originKey ?? null, cursor.path])
        if (!existing.rowCount || existing.rows[0].body !== message.text || !existing.rows[0].valid) inserted++
        message.bodyRevision = Number(result.rows[0].body_revision)
      }
      if (reconcile) {
        // 只有完整且有效的可见快照才能撤回旧消息；半行和坏文件不改变已有证据。
        const removed = await client.query(`UPDATE workbench.source_messages SET valid=false,invalid_reason='withdrawn'
          WHERE source=$1 AND valid AND (source_path=$2 OR (source_path IS NULL AND session_id=$3))
          AND NOT (id=ANY($4::text[])) RETURNING id`, [cursor.source, cursor.path, cursor.context.sessionId, messages.map((message) => message.id)])
        for (const row of removed.rows) withdrawnIds.add(row.id)
      }
      // 与抽取保存保持同样的锁顺序：先消息、再事项，避免来源变更与保存相互等待。
      await this.invalidateEvidence(client, [...editedIds], 'edited')
      await this.invalidateEvidence(client, [...withdrawnIds], 'withdrawn')
      await client.query(`INSERT INTO workbench.source_cursors(path,source,inode,byte_offset,context,modified_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,byte_offset=excluded.byte_offset,context=excluded.context,modified_at=excluded.modified_at`,
      [cursor.path, cursor.source, cursor.inode, cursor.offset, cursor.context, cursor.modifiedAt])
      return inserted
    })
  }

  async invalidateEvidence(client: PoolClient, ids: string[], reason: 'edited' | 'withdrawn'): Promise<void> {
    if (!ids.length) return
    await client.query(`UPDATE workbench.tasks t SET evidence=(SELECT jsonb_agg(CASE WHEN entry->>'messageId'=ANY($1::text[])
      THEN entry||jsonb_build_object('valid',false,'invalidReason',$2::text) ELSE entry END) FROM jsonb_array_elements(t.evidence) entry),
      evidence_stale=true,completed_at=CASE WHEN status_origin='manual' THEN completed_at ELSE NULL END,updated_at=now()
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(t.evidence) entry WHERE entry->>'messageId'=ANY($1::text[]) AND coalesce(entry->>'valid','true')='true')`, [ids, reason])
  }

  async pendingMessages(sources?: string[], after?: { timestamp: string; id: string }, limit = 500): Promise<SourceMessage[]> {
    const { rows } = await this.pool.query(`SELECT * FROM workbench.source_messages WHERE valid AND NOT extracted
      AND ($1::text[] IS NULL OR source=ANY($1)) AND ($2::timestamptz IS NULL OR (occurred_at,id)>($2::timestamptz,$3::text))
      ORDER BY occurred_at,id LIMIT $4`, [sources ?? null, after?.timestamp ?? null, after?.id ?? '', limit])
    return rows.map((row) => ({ id: row.id, source: row.source, sessionId: row.session_id, rootSessionId: row.root_session_id,
      projectPath: row.project_path, role: row.role, timestamp: new Date(row.occurred_at).toISOString(), text: row.body, bodyRevision: row.body_revision, originKey: row.origin_key ?? undefined }))
  }

  async resolveRoot(source: string, sessionId: string): Promise<string> {
    const seen = new Set<string>()
    let current = sessionId
    while (!seen.has(current)) {
      seen.add(current)
      const { rows } = await this.pool.query('SELECT parent_session_id FROM workbench.source_sessions WHERE id=$1', [`${source}:${current}`])
      const parent = rows[0]?.parent_session_id
      if (!parent) break
      current = parent
    }
    return current
  }

  async contextMessages(source: string, root: string, before: string, projectPath: string): Promise<SourceMessage[]> {
    const { rows } = await this.pool.query(`SELECT * FROM (SELECT * FROM workbench.source_messages
      WHERE source=$1 AND (root_session_id=$2 OR session_id=$2) AND occurred_at<$3 AND extracted AND valid AND project_path=$4 ORDER BY occurred_at DESC LIMIT 6) t ORDER BY occurred_at`, [source, root, before, projectPath])
    return rows.map((row) => ({ id: row.id, source: row.source, sessionId: row.session_id, rootSessionId: row.root_session_id,
      projectPath: row.project_path, role: row.role, timestamp: new Date(row.occurred_at).toISOString(), bodyRevision: row.body_revision, text: row.body.slice(0, 6000) }))
  }

  async startBatch(id: string, key: string, messages: SourceMessage[]): Promise<boolean> {
    const { rows } = await this.pool.query(`INSERT INTO workbench.extraction_batches(id,session_key,message_ids,status,attempts)
      VALUES($1,$2,$3,'running',1) ON CONFLICT(id) DO UPDATE SET status='running',attempts=workbench.extraction_batches.attempts+1,updated_at=now()
      WHERE workbench.extraction_batches.status<>'succeeded' RETURNING id`,
    [id, key, JSON.stringify(messages.map((message) => message.id))])
    return rows.length > 0
  }

  async failBatch(id: string, error: string): Promise<void> {
    await this.pool.query("UPDATE workbench.extraction_batches SET status='failed',error=$2,updated_at=now() WHERE id=$1", [id, error])
  }

  async applyExtraction(batchId: string, messages: SourceMessage[], context: SourceMessage[], items: ExtractedItem[]): Promise<{ created: number; updated: number }> {
    const evidenceMessages = new Map([...context, ...messages].map((message) => [message.id, message]))
    return withTransaction(this.pool, async (client) => {
      const batch = await client.query('SELECT status FROM workbench.extraction_batches WHERE id=$1 FOR UPDATE', [batchId])
      if (batch.rows[0]?.status === 'succeeded') return { created: 0, updated: 0 }
      if (!batch.rowCount) throw new Error('抽取批次不存在')
      const current = await client.query('SELECT id,body,valid,body_revision FROM workbench.source_messages WHERE id=ANY($1::text[]) FOR SHARE', [[...evidenceMessages.keys()]])
      const versions = new Map(current.rows.map((row) => [row.id, row]))
      for (const message of evidenceMessages.values()) {
        const row = versions.get(message.id)
        if (!row || !row.valid || (message.bodyRevision ? message.bodyRevision !== row.body_revision : row.body !== message.text)) throw new Error('来源正文已修改或撤回，下次同步将重新核对')
      }
      let created = 0, updated = 0
      const classificationChanges: Task[] = []
      for (const item of items) {
        const evidence: Evidence[] = item.evidenceIds.map((id) => {
          const message = evidenceMessages.get(id)
          if (!message) throw new Error('模型返回了不存在的来源证据')
          return { messageId: id, sessionId: message.sessionId, source: message.source, projectPath: message.projectPath, timestamp: message.timestamp, quote: message.text.slice(0, 700), valid: true }
        })
        const first = evidence.reduce((a, b) => a.timestamp < b.timestamp ? a : b)
        const last = evidence.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
        const completed = item.status === 'completed' ? last.timestamp : null
        const id = item.taskId || digest(`${batchId}:${item.title}:${[...item.evidenceIds].sort().join(':')}`)
        const existing = await client.query('SELECT * FROM workbench.tasks WHERE id=$1 FOR UPDATE', [id])
        if (existing.rows[0]) {
          const task = existing.rows[0]
          if (task.project_path !== first.projectPath || requiresManualCompletion(task.source)) throw new Error('模型尝试修改其他项目、手工事项或禅道任务')
          const merged = [...task.evidence as Evidence[], ...evidence].filter((entry, index, all) => all.findIndex((other) => other.messageId === entry.messageId && other.quote === entry.quote && other.valid === entry.valid) === index)
          const saved = await client.query(`UPDATE workbench.tasks SET title=CASE WHEN status_origin='manual' OR recorded_at>$5::timestamptz THEN title ELSE $2 END,
            completed_at=CASE WHEN status_origin='manual' OR recorded_at>$5::timestamptz THEN completed_at ELSE $3 END,evidence=$4,evidence_stale=CASE WHEN recorded_at>$5::timestamptz THEN evidence_stale ELSE false END,
            is_personal=CASE WHEN personal_origin='manual' OR recorded_at>$5::timestamptz THEN is_personal ELSE $6 END,
            recorded_at=greatest(recorded_at,$5::timestamptz),updated_at=now() WHERE id=$1 RETURNING *`, [id, item.title, completed, JSON.stringify(merged), last.timestamp, item.isPersonal ?? false])
          if (Boolean(task.is_personal) !== Boolean(saved.rows[0].is_personal)) classificationChanges.push(taskFromRow(task), taskFromRow(saved.rows[0]))
          updated++
        } else {
          if (item.taskId) throw new Error('模型返回了未知事项 ID')
          const prefix = ({ codex: 'CX', claude: 'CC', workbuddy: 'WB', zcode: 'ZC', gemini: 'GM' } as Record<string, string>)[first.source] ?? 'CH'
          const result = await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,completed_at,project_path,status_origin,evidence,recorded_at,is_personal)
            VALUES($1,$2,$3,$4,$5,$6,$7,'ai',$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
          [id, `${prefix}-${id.slice(0, 8).toUpperCase()}`, first.source, item.title, first.timestamp, completed, first.projectPath, JSON.stringify(evidence), last.timestamp, item.isPersonal ?? false])
          created += result.rowCount ?? 0
        }
      }
      if (this.onClassificationChanges) {
        await this.onClassificationChanges(client, classificationChanges)
      }
      await client.query('UPDATE workbench.source_messages SET extracted=true WHERE id=ANY($1::text[])', [messages.map((message) => message.id)])
      await client.query("UPDATE workbench.extraction_batches SET status='succeeded',error=NULL,updated_at=now() WHERE id=$1", [batchId])
      return { created, updated }
    })
  }

  async taskEvidence(id: string): Promise<Evidence[] | null> {
    const { rows } = await this.pool.query('SELECT evidence FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    return rows[0]?.evidence ?? null
  }
}
