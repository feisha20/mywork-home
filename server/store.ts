import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { isPendingTask, dateKey, recordTimestamp, requiresManualCompletion, type Task } from '../src/domain/workbench.js'
import { excludePersonalReportItems } from '../shared/dailyReports.js'
import type { DailyReport, Evidence, SyncRun, RecordQuery, RecordPage, ReportJob } from '../shared/contracts.js'
import type { Cursor, Source, SourceMessage } from './records.js'
import type { PeriodicReportModel } from '../src/domain/periodicReport.js'
import { digest } from './records.js'
import type { ZentaoSnapshot, ZentaoTrackedItem } from './zentao.js'
import { ZentaoManagementStore, visibleManagementSql } from './zentaoManagementStore.js'

const recordDateSql = `(CASE WHEN source IN ('manual','zentao') THEN completed_at ELSE coalesce(recorded_at,completed_at,created_at) END AT TIME ZONE 'Asia/Shanghai')::date`
const taskSummaryColumns = 'id,reference,source,title,created_at,completed_at,recorded_at,project_path,status_origin,is_pinned,is_personal,personal_origin,evidence_stale,zentao,management,scheduled_plan,jsonb_array_length(evidence) AS evidence_count'
function jobFromRow(row: any): ReportJob {
  return { id: row.id, kind: row.kind, day: new Date(row.day).toISOString().slice(0,10), periodKey: row.period_key,
    scheduledAt: new Date(row.scheduled_at).toISOString(), status: row.status, attempts: row.attempts,
    error: row.last_error, finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null }
}
export function taskFromRow(row: any): Task {
  return { id: row.id, reference: row.reference, source: row.source, title: row.title,
    createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    projectPath: row.project_path, statusOrigin: row.status_origin, isPinned: Boolean(row.is_pinned), isPersonal: Boolean(row.is_personal), personalOrigin: row.personal_origin,
    scheduledPlan: row.scheduled_plan, evidence: row.evidence, zentao: row.zentao, management: row.management,
    evidenceCount: row.evidence_count === undefined ? undefined : Number(row.evidence_count), evidenceStale: Boolean(row.evidence_stale) }
}

export interface ExtractedItem { taskId?: string; title: string; status: 'todo' | 'completed'; isPersonal?: boolean; evidenceIds: string[] }

export class Store {
  readonly management: ZentaoManagementStore
  constructor(readonly pool: Pool) { this.management = new ZentaoManagementStore(pool, taskFromRow) }
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
    const { rows } = await this.pool.query(`SELECT id,reference,source,title,created_at,completed_at,recorded_at,project_path,status_origin,is_personal,personal_origin,evidence_stale,management
      FROM workbench.tasks WHERE deleted_at IS NULL AND NOT is_personal AND
      ((CASE WHEN source IN ('manual','zentao') THEN completed_at ELSE coalesce(recorded_at,completed_at,created_at) END)
        AT TIME ZONE 'Asia/Shanghai')::date=$1::date
      ORDER BY coalesce(recorded_at,completed_at,created_at) DESC,id`, [day])
    return rows.map(taskFromRow)
  }
  async dailyReport(day: string): Promise<DailyReport | null> {
    const { rows } = await this.pool.query('SELECT data FROM workbench.daily_reports WHERE day=$1', [day])
    return rows[0]?.data ?? null
  }
  async dailyReports(startDate?: string, endDate?: string): Promise<DailyReport[]> {
    const { rows } = await this.pool.query('SELECT data FROM workbench.daily_reports WHERE ($1::date IS NULL OR day>=$1) AND ($2::date IS NULL OR day<=$2) ORDER BY day DESC', [startDate ?? null, endDate ?? null])
    return rows.map((row) => row.data)
  }
  async saveDailyReport(report: DailyReport, expectedRevision: number): Promise<DailyReport | null> {
    // 生成结果和已整理标记保存在同一个文档里，版本检查防止并发覆盖。
    return this.transaction(async (client) => {
      const ids = [...new Set([...Object.keys(report.recordVersions), ...report.items.flatMap((item) => item.taskIds)])]
      // 生成期间被标为个人的记录不能写回报告；行锁覆盖检查到保存之间的窗口。
      const { rows } = await client.query('SELECT is_personal,management,completed_at FROM workbench.tasks WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [ids])
      if (rows.some((row) => row.is_personal || row.management && (row.management.handlingState !== 'completed' || !row.completed_at))) return null
      const result = expectedRevision === 0
        ? await client.query(`INSERT INTO workbench.daily_reports(day,data,revision) VALUES($1,$2,1)
            ON CONFLICT(day) DO NOTHING RETURNING data`, [report.day, JSON.stringify(report)])
        : await client.query(`UPDATE workbench.daily_reports SET data=$2,revision=revision+1,updated_at=now()
            WHERE day=$1 AND revision=$3 RETURNING data`, [report.day, JSON.stringify(report), expectedRevision])
      return result.rows[0]?.data ?? null
    })
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
          WHERE id=$1 AND title=$3 AND source NOT IN ('manual','zentao') AND status_origin<>'manual'`, [item.taskId, item.title, original])
        updated += result.rowCount ?? 0
      }
      return updated
    })
  }
  async createTask(title: string, isPersonal = false) {
    const id = randomUUID()
    const { rows } = await this.pool.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,status_origin,is_personal,personal_origin)
      VALUES($1,$2,'manual',$3,now(),'manual',$4,'manual') RETURNING *`, [id, `TASK-${id.slice(0, 8).toUpperCase()}`, title, isPersonal])
    return taskFromRow(rows[0])
  }
  async setPinned(id: string, isPinned: boolean): Promise<Task | null> {
    return this.transaction(async (client) => {
      const existing = await client.query('SELECT * FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
      if (!existing.rows[0]) return null
      if (!isPendingTask(taskFromRow(existing.rows[0]))) {
        throw Object.assign(new Error('仅可置顶或取消置顶尚未完成的禅道和自定义待办'), { statusCode: 409 })
      }
      const { rows } = await client.query(`UPDATE workbench.tasks SET is_pinned=$2,updated_at=now()
        WHERE id=$1 RETURNING *`, [id, isPinned])
      return taskFromRow(rows[0])
    })
  }
  async setPersonal(id: string, isPersonal: boolean): Promise<Task | null> {
    return this.transaction(async (client) => {
      const existing = await client.query('SELECT * FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
      if (!existing.rows[0]) return null
      // 分类来源独立于完成状态，人工改正后仍允许 AI 更新真实进展。
      const { rows } = await client.query(`UPDATE workbench.tasks SET is_personal=$2,personal_origin='manual',updated_at=now()
        WHERE id=$1 RETURNING *`, [id, isPersonal])
      const saved = taskFromRow(rows[0])
      if (Boolean(existing.rows[0].is_personal) !== isPersonal) await this.updatePersonalReports(client, [saved])
      return saved
    })
  }
  private async updatePersonalReports(client: PoolClient, changedTasks: Task[]) {
    if (!changedTasks.length) return
    const ids = [...new Set(changedTasks.map((task) => task.id))]
    const changes = changedTasks.map((task) => ({ day: dateKey(new Date(recordTimestamp(task) ?? task.createdAt)), pending: !task.completedAt }))
    const personalIds = new Set<string>((await client.query('SELECT id FROM workbench.tasks WHERE id=ANY($1::text[]) AND is_personal', [ids])).rows.map((row) => row.id))
    if (personalIds.size) {
      const reports = await client.query(`SELECT day,data,revision FROM workbench.daily_reports WHERE data->'recordVersions' ?| $1::text[]
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(data->'items') item WHERE item->'taskIds' ?| $1::text[])
        ORDER BY day FOR UPDATE`, [[...personalIds]])
      for (const row of reports.rows) {
        const cleaned = excludePersonalReportItems(row.data, personalIds)
        // 同一事项可能跨日推进，早期日报引用的日期也要刷新关联周月报。
        changes.push({ day: cleaned.day, pending: false })
        await client.query(`UPDATE workbench.daily_reports SET data=$2,revision=revision+1,updated_at=now() WHERE day=$1`,
          [row.day, JSON.stringify({ ...cleaned, revision: row.revision + 1 })])
      }
    }
    // 已生成的自动周月报下次读取时重整；人工正文提示复核，防止无声覆盖编辑。
    await client.query(`UPDATE workbench.periodic_reports SET revision=revision+1,updated_at=now(),
      data=data||jsonb_build_object('needsRefresh',true,'revision',revision+1)
      WHERE EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS changed(day text,pending boolean)
        WHERE data->>'endDate'>=changed.day AND (changed.pending OR data->>'startDate'<=changed.day))`, [JSON.stringify(changes)])
  }
  async setCompleted(id: string, completed: boolean) {
    const existing = await this.pool.query('SELECT source, zentao, management FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    if (existing.rows[0]?.management) return this.management.setAction(id, completed ? 'complete' : 'restore')
    if (existing.rows[0]) {
      if (!['manual', 'zentao'].includes(existing.rows[0].source)) {
        throw Object.assign(new Error('自动工作记录直接进入日志，无需手动完成或恢复'), { statusCode: 409 })
      }
      if (existing.rows[0].source === 'zentao' && existing.rows[0].zentao?.type === 'bug') {
        throw Object.assign(new Error('禅道 Bug 状态由禅道系统驱动，无需手动修改完成状态'), { statusCode: 409 })
      }
    }
    const { rows } = await this.pool.query(`UPDATE workbench.tasks SET completed_at=CASE WHEN $2 THEN coalesce(completed_at,now()) ELSE NULL END,
      status_origin='manual',updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [id, completed])
    return rows[0] ? taskFromRow(rows[0]) : null
  }
  async zentaoTrackedItems(instance: string, account: string): Promise<ZentaoTrackedItem[]> {
    // 兼容旧版误归档、误删除的数据；已确认完成或转派的事项无需每轮补查。
    const { rows } = await this.pool.query(`SELECT zentao->>'type' AS type,zentao->>'id' AS id FROM workbench.tasks
      WHERE source='zentao' AND zentao->>'instance'=$1 AND zentao->>'account'=$2
        AND ((deleted_at IS NULL AND completed_at IS NULL) OR zentao->>'syncState'='pending'
          OR (NOT (zentao ? 'syncState') AND zentao->>'status' IN ('active','resolved','wait','doing','pause')))`, [instance, account])
    return rows as ZentaoTrackedItem[]
  }
  async applyZentaoSnapshot(snapshot: ZentaoSnapshot) {
    return this.transaction(async (client) => {
      const existing = new Set((await client.query("SELECT id FROM workbench.tasks WHERE source='zentao' AND zentao->>'instance'=$1 AND zentao->>'account'=$2", [snapshot.instance, snapshot.account])).rows.map((row) => row.id))
      let created = 0, updated = 0
      for (const item of snapshot.items) {
        // 首次只导入待处理事项，避免历史已完成任务突然进入今天的日志。
        if (item.state !== 'pending' && !existing.has(item.id)) continue
        const metadata = JSON.stringify({ ...item.zentao, syncState: item.state })
        if (item.state === 'removed') {
          updated += (await client.query(`UPDATE workbench.tasks SET
            deleted_at=CASE WHEN completed_at IS NULL OR zentao->>'type'='bug' THEN coalesce(deleted_at,now()) ELSE deleted_at END,
            zentao=$2::jsonb,updated_at=now()
            WHERE id=$1 AND (zentao IS DISTINCT FROM $2::jsonb
              OR (deleted_at IS NULL AND (completed_at IS NULL OR zentao->>'type'='bug')))`, [item.id, metadata])).rowCount ?? 0
          continue
        }
        const result = await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,completed_at,status_origin,personal_origin,zentao)
          VALUES($1,$2,'zentao',$3,$4,$5,'zentao','manual',$6::jsonb)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,zentao=excluded.zentao,deleted_at=NULL,updated_at=now(),
            completed_at=CASE
              WHEN (excluded.zentao->>'type')='bug' THEN (CASE WHEN $7 THEN NULL ELSE coalesce(excluded.completed_at,workbench.tasks.completed_at,now()) END)
              WHEN workbench.tasks.status_origin='manual' THEN workbench.tasks.completed_at
              WHEN $7 THEN NULL ELSE coalesce(excluded.completed_at,workbench.tasks.completed_at,now()) END,
            status_origin=CASE WHEN (excluded.zentao->>'type')='bug' THEN 'zentao' ELSE workbench.tasks.status_origin END
          WHERE (workbench.tasks.title,workbench.tasks.zentao,workbench.tasks.deleted_at) IS DISTINCT FROM (excluded.title,excluded.zentao,NULL::timestamptz)
            OR workbench.tasks.completed_at IS DISTINCT FROM
              CASE
                WHEN (excluded.zentao->>'type')='bug' THEN (CASE WHEN $7 THEN NULL ELSE coalesce(excluded.completed_at,workbench.tasks.completed_at,now()) END)
                WHEN workbench.tasks.status_origin='manual' THEN workbench.tasks.completed_at
                WHEN $7 THEN NULL ELSE coalesce(excluded.completed_at,workbench.tasks.completed_at,now()) END
          RETURNING id`, [item.id, item.reference, item.title, item.createdAt, item.state === 'pending' ? null : item.completedAt, metadata, item.state === 'pending'])
        if (result.rowCount) { if (existing.has(item.id)) updated++; else created++ }
      }
      // 只依据详情确认的转派、取消或删除移除待办；个人列表缺席本身不代表删除。
      return { created, updated }
    })
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
        const result = await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,completed_at,status_origin,is_personal,personal_origin)
          VALUES($1,$2,'manual',$3,$4,$5,'manual',$6,'manual') ON CONFLICT(id) DO NOTHING`, [task.id, task.reference, task.title, task.createdAt, task.completedAt, task.isPersonal ?? false])
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
  async ingest(messages: SourceMessage[], cursor: Cursor, reconcile = false) {
    return this.transaction(async (client) => {
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
  async pendingMessages(sources?: string[], after?: { timestamp: string; id: string }, limit = 500): Promise<SourceMessage[]> {
    const { rows } = await this.pool.query(`SELECT * FROM workbench.source_messages WHERE valid AND NOT extracted
      AND ($1::text[] IS NULL OR source=ANY($1)) AND ($2::timestamptz IS NULL OR (occurred_at,id)>($2::timestamptz,$3::text))
      ORDER BY occurred_at,id LIMIT $4`, [sources ?? null, after?.timestamp ?? null, after?.id ?? '', limit])
    return rows.map((row) => ({ id: row.id, source: row.source, sessionId: row.session_id, rootSessionId: row.root_session_id,
      projectPath: row.project_path, role: row.role, timestamp: new Date(row.occurred_at).toISOString(), text: row.body, bodyRevision: row.body_revision, originKey: row.origin_key ?? undefined }))
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
      WHERE source=$1 AND (root_session_id=$2 OR session_id=$2) AND occurred_at<$3 AND extracted AND valid AND project_path=$4 ORDER BY occurred_at DESC LIMIT 6) t ORDER BY occurred_at`, [source, root, before, projectPath])
    return rows.map((row) => ({ id: row.id, source: row.source, sessionId: row.session_id, rootSessionId: row.root_session_id,
      projectPath: row.project_path, role: row.role, timestamp: new Date(row.occurred_at).toISOString(), bodyRevision: row.body_revision, text: row.body.slice(0, 6000) }))
  }
  async projectTasks(path: string) {
    const { rows } = await this.pool.query("SELECT * FROM workbench.tasks WHERE project_path=$1 AND source<>'zentao' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100", [path])
    return rows.map(taskFromRow)
  }
  batchId(messages: SourceMessage[]) { return digest(`v2:${messages.map((message) => `${message.id}:${message.bodyRevision ?? 1}:${digest(message.text)}`).join(':')}`) }
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
      await this.updatePersonalReports(client, classificationChanges)
      await client.query('UPDATE workbench.source_messages SET extracted=true WHERE id=ANY($1::text[])', [messages.map((message) => message.id)])
      await client.query("UPDATE workbench.extraction_batches SET status='succeeded',error=NULL,updated_at=now() WHERE id=$1", [batchId])
      return { created, updated }
    })
  }
  private async invalidateEvidence(client: PoolClient, ids: string[], reason: 'edited' | 'withdrawn') {
    if (!ids.length) return
    await client.query(`UPDATE workbench.tasks t SET evidence=(SELECT jsonb_agg(CASE WHEN entry->>'messageId'=ANY($1::text[])
      THEN entry||jsonb_build_object('valid',false,'invalidReason',$2::text) ELSE entry END) FROM jsonb_array_elements(t.evidence) entry),
      evidence_stale=true,completed_at=CASE WHEN status_origin='manual' THEN completed_at ELSE NULL END,updated_at=now()
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(t.evidence) entry WHERE entry->>'messageId'=ANY($1::text[]) AND coalesce(entry->>'valid','true')='true')`, [ids, reason])
  }
  async snapshotTasks(day: string) {
    const { rows } = await this.pool.query(`SELECT ${taskSummaryColumns} FROM workbench.tasks WHERE deleted_at IS NULL
      AND (${visibleManagementSql}) AND ((source IN ('manual','zentao') AND completed_at IS NULL) OR (${recordDateSql})=$1::date)
      ORDER BY created_at DESC,id`, [day])
    return rows.map(taskFromRow)
  }
  async recordedDays(): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT DISTINCT to_char(${recordDateSql},'YYYY-MM-DD') AS day FROM workbench.tasks WHERE deleted_at IS NULL AND ${recordDateSql} IS NOT NULL ORDER BY day DESC`)
    return rows.map((row) => row.day)
  }
  async dataVersion(): Promise<string> {
    const { rows } = await this.pool.query(`SELECT greatest(
      (SELECT max(updated_at) FROM workbench.tasks),(SELECT max(updated_at) FROM workbench.daily_reports),
      (SELECT max(updated_at) FROM workbench.periodic_reports),(SELECT max(updated_at) FROM workbench.zentao_management_status))::text AS version`)
    return rows[0].version ?? 'empty'
  }
  async recordPage(input: RecordQuery): Promise<RecordPage> {
    const limit = input.limit ?? 50, offset = input.offset ?? 0
    const params = [input.startDate ?? null, input.endDate ?? null, input.onlyRecords ?? false]
    const where = `deleted_at IS NULL AND (${visibleManagementSql})
      AND ($1::date IS NULL OR coalesce(${recordDateSql},(created_at AT TIME ZONE 'Asia/Shanghai')::date)>=$1)
      AND ($2::date IS NULL OR coalesce(${recordDateSql},(created_at AT TIME ZONE 'Asia/Shanghai')::date)<=$2) AND (NOT $3::boolean OR ${recordDateSql} IS NOT NULL)`
    const count = await this.pool.query(`SELECT count(*)::int AS count FROM workbench.tasks WHERE ${where}`, params)
    const { rows } = await this.pool.query(`SELECT ${taskSummaryColumns} FROM workbench.tasks WHERE ${where}
      ORDER BY coalesce(recorded_at,completed_at,created_at) DESC,id LIMIT $4 OFFSET $5`, [...params, limit, offset])
    return { tasks: rows.map(taskFromRow), total: count.rows[0].count, offset, limit }
  }
  async taskEvidence(id: string): Promise<Evidence[] | null> {
    const { rows } = await this.pool.query('SELECT evidence FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    return rows[0]?.evidence ?? null
  }
  async periodTasks(_startDate: string, _endDate: string): Promise<Task[]> {
    // 原版聚合包含周期结束前的未完成事项与全局项目统计，由领域逻辑筛选。
    const { rows } = await this.pool.query(`SELECT ${taskSummaryColumns} FROM workbench.tasks WHERE deleted_at IS NULL AND ${visibleManagementSql} ORDER BY created_at DESC,id`)
    return rows.map(taskFromRow)
  }
  async periodicReports(): Promise<PeriodicReportModel[]> {
    return (await this.pool.query('SELECT data FROM workbench.periodic_reports ORDER BY type,period_key')).rows.map((row) => row.data)
  }
  async periodicReport(type: 'weekly' | 'monthly', key: string): Promise<PeriodicReportModel | null> {
    return (await this.pool.query('SELECT data FROM workbench.periodic_reports WHERE type=$1 AND period_key=$2', [type, key])).rows[0]?.data ?? null
  }
  async savePeriodicReport(report: PeriodicReportModel, expectedRevision: number, scopeSnapshot?: Task[]): Promise<PeriodicReportModel | null> {
    const data = { ...report, revision: expectedRevision + 1 }
    return this.transaction(async (client) => {
      if (scopeSnapshot) {
        const { rows } = await client.query('SELECT id,is_personal FROM workbench.tasks WHERE deleted_at IS NULL ORDER BY id FOR SHARE')
        const scopes = new Map(scopeSnapshot.map((task) => [task.id, Boolean(task.isPersonal)]))
        if (rows.some((row) => Boolean(row.is_personal) !== (scopes.get(row.id) ?? false))) return null
      }
      const result = expectedRevision === 0
        ? await client.query(`INSERT INTO workbench.periodic_reports(type,period_key,data,revision) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING RETURNING data`, [report.type, report.periodKey, JSON.stringify(data)])
        : await client.query(`UPDATE workbench.periodic_reports SET data=$3,revision=revision+1,updated_at=now() WHERE type=$1 AND period_key=$2 AND revision=$4 RETURNING data`, [report.type, report.periodKey, JSON.stringify(data), expectedRevision])
      return result.rows[0]?.data ?? null
    })
  }
  async scheduleCheckpoint(): Promise<string | null> {
    return (await this.pool.query("SELECT value FROM workbench.settings WHERE key='report_schedule_checkpoint'")).rows[0]?.value ?? null
  }
  async enqueueReportJobs(jobs: ReportJob[], checkpoint: string) {
    await this.transaction(async (client) => {
      for (const job of jobs) await client.query(`INSERT INTO workbench.report_jobs(id,kind,day,period_key,scheduled_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [job.id, job.kind, job.day, job.periodKey, job.scheduledAt])
      await client.query(`INSERT INTO workbench.settings(key,value) VALUES('report_schedule_checkpoint',$1) ON CONFLICT(key) DO UPDATE SET value=greatest(workbench.settings.value,excluded.value)`, [checkpoint])
    })
  }
  async claimReportJob(kinds: string[], token: string): Promise<ReportJob | null> {
    const { rows } = await this.pool.query(`UPDATE workbench.report_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '10 minutes'
      WHERE id=(SELECT id FROM workbench.report_jobs WHERE kind=ANY($1::text[]) AND
      ((status IN ('pending','failed') AND next_attempt_at<=now()) OR (status='running' AND lease_until<now()))
      ORDER BY scheduled_at,CASE kind WHEN 'daily' THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [kinds, token])
    return rows[0] ? jobFromRow(rows[0]) : null
  }
  async finishReportJob(id: string, token: string, status: 'succeeded' | 'failed' | 'skipped', error: string | null = null) {
    await this.pool.query(`UPDATE workbench.report_jobs SET status=$3,last_error=$4,finished_at=now(),lease_until=NULL,
      next_attempt_at=now()+make_interval(mins=>least(60,5*attempts)) WHERE id=$1 AND lease_token=$2`, [id, token, status, error])
  }
  async renewReportJob(id: string, token: string) {
    await this.pool.query("UPDATE workbench.report_jobs SET lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_token=$2 AND status='running'", [id, token])
  }
  async retryReportJob(id: string): Promise<boolean> {
    return Boolean((await this.pool.query("UPDATE workbench.report_jobs SET status='pending',next_attempt_at=now(),last_error=NULL WHERE id=$1 AND status IN ('failed','skipped') RETURNING id", [id])).rowCount)
  }
  async reportJobs(): Promise<ReportJob[]> {
    return (await this.pool.query('SELECT * FROM workbench.report_jobs ORDER BY scheduled_at DESC LIMIT 30')).rows.map(jobFromRow)
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
  async zentaoPendingCount(instance?: string, account?: string): Promise<number> {
    const params = [instance ?? null, account ?? null]
    const { rows } = await this.pool.query(`SELECT count(*)::int AS count FROM workbench.tasks
      WHERE source='zentao' AND deleted_at IS NULL AND completed_at IS NULL AND (${visibleManagementSql})
        AND ($1::text IS NULL OR zentao->>'instance'=$1 OR management->>'instance'=$1)
        AND ($2::text IS NULL OR zentao->>'account'=$2 OR management->>'account'=$2)`, params)
    return rows[0]?.count ?? 0
  }
}
