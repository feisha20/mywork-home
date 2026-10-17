import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { isPendingTask, dateKey, recordTimestamp, type Task } from '../../src/domain/workbench.js'
import { excludePersonalReportItems } from '../../shared/dailyReports.js'
import type { RecordQuery, RecordPage } from '../../shared/contracts.js'
import type { ZentaoSnapshot, ZentaoTrackedItem } from '../zentao.js'
import type { ZentaoManagementStore } from '../zentaoManagementStore.js'
import { taskFromRow, recordDateSql, taskSummaryColumns, visibleManagementSql, withTransaction } from './db.js'

export class TaskRepository {
  constructor(
    private readonly pool: Pool,
    private readonly getManagement?: () => ZentaoManagementStore,
  ) {}

  async tasks(): Promise<Task[]> {
    const { rows } = await this.pool.query('SELECT * FROM workbench.tasks WHERE deleted_at IS NULL ORDER BY created_at DESC, id')
    return rows.map(taskFromRow)
  }

  async snapshotTasks(day: string): Promise<Task[]> {
    const { rows } = await this.pool.query(`SELECT ${taskSummaryColumns} FROM workbench.tasks WHERE deleted_at IS NULL
      AND (${visibleManagementSql}) AND ((source IN ('manual','zentao') AND completed_at IS NULL) OR (${recordDateSql})=$1::date)
      ORDER BY created_at DESC,id`, [day])
    return rows.map(taskFromRow)
  }

  async recordedDays(): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT DISTINCT to_char(${recordDateSql},'YYYY-MM-DD') AS day FROM workbench.tasks WHERE deleted_at IS NULL AND ${recordDateSql} IS NOT NULL ORDER BY day DESC`)
    return rows.map((row) => row.day)
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

  async projectTasks(path: string): Promise<Task[]> {
    const { rows } = await this.pool.query("SELECT * FROM workbench.tasks WHERE project_path=$1 AND source<>'zentao' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100", [path])
    return rows.map(taskFromRow)
  }

  async periodTasks(_startDate: string, _endDate: string): Promise<Task[]> {
    // 原版聚合包含周期结束前的未完成事项与全局项目统计，由领域逻辑筛选。
    const { rows } = await this.pool.query(`SELECT ${taskSummaryColumns} FROM workbench.tasks WHERE deleted_at IS NULL AND ${visibleManagementSql} ORDER BY created_at DESC,id`)
    return rows.map(taskFromRow)
  }

  async createTask(title: string, isPersonal = false): Promise<Task> {
    const id = randomUUID()
    const { rows } = await this.pool.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,status_origin,is_personal,personal_origin)
      VALUES($1,$2,'manual',$3,now(),'manual',$4,'manual') RETURNING *`, [id, `TASK-${id.slice(0, 8).toUpperCase()}`, title, isPersonal])
    return taskFromRow(rows[0])
  }

  async setPinned(id: string, isPinned: boolean): Promise<Task | null> {
    return withTransaction(this.pool, async (client) => {
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
    return withTransaction(this.pool, async (client) => {
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

  async updatePersonalReports(client: PoolClient, changedTasks: Task[]): Promise<void> {
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

  async setCompleted(id: string, completed: boolean): Promise<Task | null> {
    const existing = await this.pool.query('SELECT source, zentao, management FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    if (existing.rows[0]?.management) {
      const mgmt = this.getManagement?.()
      if (!mgmt) throw new Error('禅道管理服务未就绪')
      return mgmt.setAction(id, completed ? 'complete' : 'restore')
    }
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

  async deleteTask(id: string): Promise<boolean> {
    // 保留删除标记，旧缓存再次导入时不会把已删除的待办复活。
    const result = await this.pool.query(`UPDATE workbench.tasks SET deleted_at=now(),updated_at=now()
      WHERE id=$1 AND source='manual' AND completed_at IS NULL AND deleted_at IS NULL RETURNING id`, [id])
    if (result.rowCount) return true
    const existing = await this.pool.query('SELECT id FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL', [id])
    if (existing.rowCount) throw Object.assign(new Error('仅可删除手动新增且尚未完成的待办'), { statusCode: 409 })
    return false
  }

  async importTasks(tasks: Task[]): Promise<{ imported: number; duplicates: number }> {
    return withTransaction(this.pool, async (client) => {
      let imported = 0
      for (const task of tasks) {
        const result = await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,completed_at,status_origin,is_personal,personal_origin)
          VALUES($1,$2,'manual',$3,$4,$5,'manual',$6,'manual') ON CONFLICT(id) DO NOTHING`, [task.id, task.reference, task.title, task.createdAt, task.completedAt, task.isPersonal ?? false])
        imported += result.rowCount ?? 0
      }
      return { imported, duplicates: tasks.length - imported }
    })
  }

  async applySummaries(tasks: Task[], items: { taskId: string; title: string }[]): Promise<number> {
    const originals = new Map(tasks.map((task) => [task.id, task.title]))
    return withTransaction(this.pool, async (client) => {
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

  async zentaoTrackedItems(instance: string, account: string): Promise<ZentaoTrackedItem[]> {
    // 兼容旧版误归档、误删除的数据；已确认完成或转派的事项无需每轮补查。
    const { rows } = await this.pool.query(`SELECT zentao->>'type' AS type,zentao->>'id' AS id FROM workbench.tasks
      WHERE source='zentao' AND zentao->>'instance'=$1 AND zentao->>'account'=$2
        AND ((deleted_at IS NULL AND completed_at IS NULL) OR zentao->>'syncState'='pending'
          OR (NOT (zentao ? 'syncState') AND zentao->>'status' IN ('active','resolved','wait','doing','pause')))`, [instance, account])
    return rows as ZentaoTrackedItem[]
  }

  async applyZentaoSnapshot(snapshot: ZentaoSnapshot): Promise<{ created: number; updated: number }> {
    return withTransaction(this.pool, async (client) => {
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
      return { created, updated }
    })
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
