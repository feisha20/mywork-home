import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { requiresManualCompletion, type Task } from '../src/domain/workbench.js'
import type { DailyReport, Evidence, SyncRun } from '../shared/contracts.js'
import type { Cursor, Source, SourceMessage } from './records.js'
import { digest } from './records.js'

function taskFromRow(row: any): Task {
  return { id: row.id, reference: row.reference, source: row.source, title: row.title,
    createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    projectPath: row.project_path, statusOrigin: row.status_origin, evidence: row.evidence }
}

export interface ExtractedItem { taskId?: string; title: string; status: 'todo' | 'completed'; evidenceIds: string[] }

export class Store {
  constructor(readonly pool: Pool) {}
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async tasks() {
    const { rows } = await this.pool.query('SELECT * FROM workbench.tasks WHERE deleted_at IS NULL ORDER BY created_at DESC, id')
    return rows.map(taskFromRow)
  }
  async reportRecords(day: string): Promise<Task[]> {
    // 日报只读取简介与归档信息，不查询会话证据内容。
    const { rows } = await this.pool.query(`SELECT id,reference,source,title,created_at,completed_at,recorded_at,project_path,status_origin
      FROM workbench.tasks WHERE deleted_at IS NULL AND
      ((CASE WHEN source IN ('manual','zentao') THEN completed_at ELSE coalesce(recorded_at,completed_at,created_at) END)
        AT TIME ZONE 'Asia/Shanghai')::date=$1::date
      ORDER BY coalesce(recorded_at,completed_at,created_at) DESC,id`, [day])
    return rows.map(taskFromRow)
  }
  async dailyReport(day: string): Promise<DailyReport | null> {
    const { rows } = await this.pool.query('SELECT data FROM workbench.daily_reports WHERE day=$1', [day])
    return rows[0]?.data ?? null
  }
  async dailyReports(): Promise<DailyReport[]> {
    const { rows } = await this.pool.query('SELECT data FROM workbench.daily_reports ORDER BY day DESC')
    return rows.map((row) => row.data)
  }
  async saveDailyReport(report: DailyReport, expectedRevision: number): Promise<DailyReport | null> {
    // 生成结果和已整理标记保存在同一个文档里，版本检查防止并发覆盖。
    const result = expectedRevision === 0
      ? await this.pool.query(`INSERT INTO workbench.daily_reports(day,data,revision) VALUES($1,$2,1)
          ON CONFLICT(day) DO NOTHING RETURNING data`, [report.day, JSON.stringify(report)])
      : await this.pool.query(`UPDATE workbench.daily_reports SET data=$2,revision=revision+1,updated_at=now()
          WHERE day=$1 AND revision=$3 RETURNING data`, [report.day, JSON.stringify(report), expectedRevision])
    return result.rows[0]?.data ?? null
  }
  async applySummaries(tasks: Task[], items: { taskId: string; title: string }[]) {
    const originals = new Map(tasks.map((task) => [task.id, task.title]))
    return this.transaction(async (client) => {
      let updated = 0
      for (const item of items) {
        const original = originals.get(item.taskId)
        if (!original || item.title.length > 60 || !item.title.trim()) throw new Error('工作简介校验失败')
        // 仅更新简介；期间被用户改动的事项跳过，不修改状态、日期、证据及同步游标。
        const result = await client.query(`UPDATE workbench.tasks SET title=$2,updated_at=now()
          WHERE id=$1 AND title=$3 AND source<>'manual' AND status_origin<>'manual'`, [item.taskId, item.title, original])
        updated += result.rowCount ?? 0
      }
      return updated
    })
  }
  async createTask(title: string) {
    const id = randomUUID()
    const { rows } = await this.pool.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,status_origin)
      VALUES($1,$2,'manual',$3,now(),'manual') RETURNING *`, [id, `TASK-${id.slice(0, 8).toUpperCase()}`, title])
    return taskFromRow(rows[0])
  }
  async setCompleted(id: string, completed: boolean) {
    const existing = await this.pool.query('SELECT source FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    if (existing.rows[0] && !['manual', 'zentao'].includes(existing.rows[0].source)) {
      throw Object.assign(new Error('自动工作记录直接进入日志，无需手动完成或恢复'), { statusCode: 409 })
    }
    const { rows } = await this.pool.query(`UPDATE workbench.tasks SET completed_at=CASE WHEN $2 THEN coalesce(completed_at,now()) ELSE NULL END,
      status_origin='manual',updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [id, completed])
    return rows[0] ? taskFromRow(rows[0]) : null
  }
  async deleteTask(id: string): Promise<boolean> {
    // 保留删除标记，旧缓存再次导入时不会把已删除的待办复活。
    const result = await this.pool.query(`UPDATE workbench.tasks SET deleted_at=now(),updated_at=now()
      WHERE id=$1 AND source='manual' AND completed_at IS NULL AND deleted_at IS NULL RETURNING id`, [id])
    if (result.rowCount) return true
    const existing = await this.pool.query('SELECT id FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    if (existing.rowCount) throw Object.assign(new Error('仅可删除手动新增且尚未完成的待办'), { statusCode: 409 })
    return false
  }
  async importTasks(tasks: Task[]) {
    return this.transaction(async (client) => {
      let imported = 0
      for (const task of tasks) {
        const result = await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,completed_at,status_origin)
          VALUES($1,$2,'manual',$3,$4,$5,'manual') ON CONFLICT(id) DO NOTHING`, [task.id, task.reference, task.title, task.createdAt, task.completedAt])
        imported += result.rowCount ?? 0
      }
      return { imported, duplicates: tasks.length - imported }
    })
  }
  async cutoff() {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { rows } = await this.pool.query(`INSERT INTO workbench.settings(key,value) VALUES('initial_cutoff',$1)
      ON CONFLICT(key) DO UPDATE SET value=workbench.settings.value RETURNING value`, [cutoff])
    return rows[0].value as string
  }
  async cursor(path: string): Promise<Cursor | null> {
    const { rows } = await this.pool.query('SELECT * FROM workbench.source_cursors WHERE path=$1', [path])
    const row = rows[0]
    return row ? { path, source: row.source, inode: row.inode, offset: Number(row.byte_offset), context: row.context, modifiedAt: Number(row.modified_at) } : null
  }
  async recordIgnored(path: string, fingerprint: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT attempts FROM workbench.record_failures WHERE path=$1 AND fingerprint=$2', [path, fingerprint])
    return rows[0]?.attempts >= 2
  }
  async failRecord(path: string, source: Source, fingerprint: string, runId: string): Promise<number> {
    // 每份文件内容最多记两次失败；同轮多次读取只计一次，文件变化后重新计数。
    const { rows } = await this.pool.query(`INSERT INTO workbench.record_failures(path,source,fingerprint,attempts,last_run_id)
      VALUES($1,$2,$3,1,$4) ON CONFLICT(path) DO UPDATE SET
      fingerprint=excluded.fingerprint,
      attempts=CASE WHEN workbench.record_failures.fingerprint<>excluded.fingerprint THEN 1
        WHEN workbench.record_failures.last_run_id=excluded.last_run_id THEN workbench.record_failures.attempts
        ELSE least(workbench.record_failures.attempts+1,2) END,
      last_run_id=excluded.last_run_id,updated_at=now() RETURNING attempts`, [path, source, fingerprint, runId])
    return rows[0].attempts
  }
  async clearRecordFailure(path: string) {
    await this.pool.query('DELETE FROM workbench.record_failures WHERE path=$1', [path])
  }
  async ingest(messages: SourceMessage[], cursor: Cursor) {
    return this.transaction(async (client) => {
      let inserted = 0
      const sessionKey = `${cursor.source}:${cursor.context.sessionId}`
      await client.query(`INSERT INTO workbench.source_sessions(id,source,session_id,project_path,parent_session_id,updated_at)
        VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path,parent_session_id=excluded.parent_session_id,updated_at=now()`,
      [sessionKey, cursor.source, cursor.context.sessionId, cursor.context.projectPath, cursor.context.parentSessionId])
      for (const message of messages) {
        const key = `${message.source}:${message.sessionId}`
        if (key !== sessionKey) await client.query(`INSERT INTO workbench.source_sessions(id,source,session_id,project_path,updated_at)
          VALUES($1,$2,$3,$4,now()) ON CONFLICT(id) DO NOTHING`, [key, message.source, message.sessionId, message.projectPath])
        const result = await client.query(`INSERT INTO workbench.source_messages(id,session_key,source,session_id,root_session_id,project_path,role,occurred_at,body)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
        [message.id, key, message.source, message.sessionId, message.rootSessionId, message.projectPath, message.role, message.timestamp, message.text])
        inserted += result.rowCount ?? 0
      }
      await client.query(`INSERT INTO workbench.source_cursors(path,source,inode,byte_offset,context,modified_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,byte_offset=excluded.byte_offset,context=excluded.context,modified_at=excluded.modified_at`,
      [cursor.path, cursor.source, cursor.inode, cursor.offset, cursor.context, cursor.modifiedAt])
      return inserted
    })
  }
  async pendingMessages(): Promise<SourceMessage[]> {
    const { rows } = await this.pool.query('SELECT * FROM workbench.source_messages WHERE NOT extracted ORDER BY occurred_at,id')
    return rows.map((row) => ({ id: row.id, source: row.source, sessionId: row.session_id, rootSessionId: row.root_session_id,
      projectPath: row.project_path, role: row.role, timestamp: new Date(row.occurred_at).toISOString(), text: row.body }))
  }
  async resolveRoot(source: string, sessionId: string) {
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
      WHERE source=$1 AND (root_session_id=$2 OR session_id=$2) AND occurred_at<$3 AND extracted AND project_path=$4 ORDER BY occurred_at DESC LIMIT 6) t ORDER BY occurred_at`, [source, root, before, projectPath])
    return rows.map((row) => ({ id: row.id, source: row.source, sessionId: row.session_id, rootSessionId: row.root_session_id,
      projectPath: row.project_path, role: row.role, timestamp: new Date(row.occurred_at).toISOString(), text: row.body.slice(0, 6000) }))
  }
  async projectTasks(path: string) {
    const { rows } = await this.pool.query('SELECT * FROM workbench.tasks WHERE project_path=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100', [path])
    return rows.map(taskFromRow)
  }
  batchId(messages: SourceMessage[]) { return digest(`v1:${messages.map((message) => message.id).join(':')}`) }
  async startBatch(id: string, key: string, messages: SourceMessage[]) {
    const { rows } = await this.pool.query(`INSERT INTO workbench.extraction_batches(id,session_key,message_ids,status,attempts)
      VALUES($1,$2,$3,'running',1) ON CONFLICT(id) DO UPDATE SET status='running',attempts=workbench.extraction_batches.attempts+1,updated_at=now()
      WHERE workbench.extraction_batches.status<>'succeeded' RETURNING id`,
    [id, key, JSON.stringify(messages.map((message) => message.id))])
    return rows.length > 0
  }
  async failBatch(id: string, error: string) {
    await this.pool.query("UPDATE workbench.extraction_batches SET status='failed',error=$2,updated_at=now() WHERE id=$1", [id, error])
  }
  async applyExtraction(batchId: string, messages: SourceMessage[], context: SourceMessage[], items: ExtractedItem[]) {
    const evidenceMessages = new Map([...context, ...messages].map((message) => [message.id, message]))
    return this.transaction(async (client) => {
      const batch = await client.query('SELECT status FROM workbench.extraction_batches WHERE id=$1 FOR UPDATE', [batchId])
      if (batch.rows[0]?.status === 'succeeded') return { created: 0, updated: 0 }
      if (!batch.rowCount) throw new Error('抽取批次不存在')
      let created = 0, updated = 0
      for (const item of items) {
        const evidence: Evidence[] = item.evidenceIds.map((id) => {
          const message = evidenceMessages.get(id)
          if (!message) throw new Error('模型返回了不存在的来源证据')
          return { messageId: id, sessionId: message.sessionId, source: message.source, projectPath: message.projectPath, timestamp: message.timestamp, quote: message.text.slice(0, 700) }
        })
        const first = evidence.reduce((a, b) => a.timestamp < b.timestamp ? a : b)
        const last = evidence.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
        const completed = item.status === 'completed' ? last.timestamp : null
        const id = item.taskId || digest(`${batchId}:${item.title}:${[...item.evidenceIds].sort().join(':')}`)
        const existing = await client.query('SELECT * FROM workbench.tasks WHERE id=$1 FOR UPDATE', [id])
        if (existing.rows[0]) {
          const task = existing.rows[0]
          if (task.project_path !== first.projectPath || requiresManualCompletion(task.source)) throw new Error('模型尝试修改其他项目、手工事项或禅道任务')
          const merged = [...task.evidence as Evidence[], ...evidence].filter((entry, index, all) => all.findIndex((other) => other.messageId === entry.messageId) === index)
          await client.query(`UPDATE workbench.tasks SET title=CASE WHEN status_origin='manual' THEN title ELSE $2 END,
            completed_at=CASE WHEN status_origin='manual' THEN completed_at ELSE $3 END,evidence=$4,
            recorded_at=greatest(recorded_at,$5::timestamptz),updated_at=now() WHERE id=$1`, [id, item.title, completed, JSON.stringify(merged), last.timestamp])
          updated++
        } else {
          if (item.taskId) throw new Error('模型返回了未知事项 ID')
          const prefix = { codex: 'CX', claude: 'CC', workbuddy: 'WB', zcode: 'ZC', gemini: 'GM' }[first.source]
          const result = await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,completed_at,project_path,status_origin,evidence,recorded_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'ai',$8,$9) ON CONFLICT(id) DO NOTHING`,
          [id, `${prefix}-${id.slice(0, 8).toUpperCase()}`, first.source, item.title, first.timestamp, completed, first.projectPath, JSON.stringify(evidence), last.timestamp])
          created += result.rowCount ?? 0
        }
      }
      await client.query('UPDATE workbench.source_messages SET extracted=true WHERE id=ANY($1::text[])', [messages.map((message) => message.id)])
      await client.query("UPDATE workbench.extraction_batches SET status='succeeded',error=NULL,updated_at=now() WHERE id=$1", [batchId])
      return { created, updated }
    })
  }
  async saveRun(run: SyncRun) {
    await this.pool.query('INSERT INTO workbench.sync_runs(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [run.id, JSON.stringify(run)])
  }
  async latestRun(): Promise<SyncRun | null> {
    return (await this.pool.query('SELECT data FROM workbench.sync_runs ORDER BY started_at DESC LIMIT 1')).rows[0]?.data ?? null
  }
  async run(id: string): Promise<SyncRun | null> { return (await this.pool.query('SELECT data FROM workbench.sync_runs WHERE id=$1', [id])).rows[0]?.data ?? null }
  async interruptRuns() {
    await this.pool.query(`UPDATE workbench.sync_runs SET data=data||jsonb_build_object('status','interrupted','phase','idle','finishedAt',$1::text)
      WHERE data->>'status'='running'`, [new Date().toISOString()])
  }
  async sourceCounts() {
    return (await this.pool.query('SELECT source,count(*)::int AS count FROM workbench.source_sessions GROUP BY source')).rows as { source: Source; count: number }[]
  }
}
