import type { Pool } from 'pg'
import type { DailyReport } from '../../shared/contracts.js'
import type { Task } from '../../src/domain/workbench.js'
import type { PeriodicReportModel } from '../../src/domain/periodicReport.js'
import { taskFromRow, recordDateSql, recordTimestampSql, withTransaction } from './db.js'

export class ReportRepository {
  constructor(private readonly pool: Pool) {}

  async reportRecords(day: string): Promise<Task[]> {
    // 日报只读取简介与归档信息，不查询会话证据内容。
    const { rows } = await this.pool.query(`SELECT id,reference,source,title,created_at,completed_at,recorded_at,project_path,status_origin,is_personal,personal_origin,evidence_stale,management,scheduled_plan
      FROM workbench.tasks WHERE deleted_at IS NULL AND NOT is_personal AND
      ${recordDateSql}=$1::date
      ORDER BY ${recordTimestampSql} DESC,id`, [day])
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
    return withTransaction(this.pool, async (client) => {
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

  async periodicReports(): Promise<PeriodicReportModel[]> {
    return (await this.pool.query('SELECT data FROM workbench.periodic_reports ORDER BY type,period_key')).rows.map((row) => row.data)
  }

  async periodicReport(type: 'weekly' | 'monthly', key: string): Promise<PeriodicReportModel | null> {
    return (await this.pool.query('SELECT data FROM workbench.periodic_reports WHERE type=$1 AND period_key=$2', [type, key])).rows[0]?.data ?? null
  }

  async savePeriodicReport(report: PeriodicReportModel, expectedRevision: number, scopeSnapshot?: Task[]): Promise<PeriodicReportModel | null> {
    const data = { ...report, revision: expectedRevision + 1 }
    return withTransaction(this.pool, async (client) => {
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
}
