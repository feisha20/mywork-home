import type { Pool } from 'pg'
import type { ReportJob, SyncRun } from '../../shared/contracts.js'
import type { Source } from '../records.js'
import { jobFromRow, withTransaction } from './db.js'

export class SyncRunRepository {
  constructor(private readonly pool: Pool) {}

  async dataVersion(): Promise<string> {
    const { rows } = await this.pool.query(`SELECT greatest(
      (SELECT max(updated_at) FROM workbench.tasks),(SELECT max(updated_at) FROM workbench.daily_reports),
      (SELECT max(updated_at) FROM workbench.periodic_reports),(SELECT max(updated_at) FROM workbench.zentao_management_status))::text AS version`)
    return rows[0].version ?? 'empty'
  }

  async saveRun(run: SyncRun): Promise<void> {
    await this.pool.query('INSERT INTO workbench.sync_runs(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [run.id, JSON.stringify(run)])
  }

  async latestRun(): Promise<SyncRun | null> {
    return (await this.pool.query('SELECT data FROM workbench.sync_runs ORDER BY started_at DESC LIMIT 1')).rows[0]?.data ?? null
  }

  async run(id: string): Promise<SyncRun | null> {
    return (await this.pool.query('SELECT data FROM workbench.sync_runs WHERE id=$1', [id])).rows[0]?.data ?? null
  }

  async interruptRuns(): Promise<void> {
    await this.pool.query(`UPDATE workbench.sync_runs SET data=data||jsonb_build_object('status','interrupted','phase','idle','finishedAt',$1::text)
      WHERE data->>'status'='running'`, [new Date().toISOString()])
  }

  async sourceCounts(): Promise<{ source: Source; count: number }[]> {
    return (await this.pool.query('SELECT source,count(*)::int AS count FROM workbench.source_sessions GROUP BY source')).rows as { source: Source; count: number }[]
  }

  async scheduleCheckpoint(): Promise<string | null> {
    return (await this.pool.query("SELECT value FROM workbench.settings WHERE key='report_schedule_checkpoint'")).rows[0]?.value ?? null
  }

  async enqueueReportJobs(jobs: ReportJob[], checkpoint: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      for (const job of jobs) {
        await client.query(`INSERT INTO workbench.report_jobs(id,kind,day,period_key,scheduled_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [job.id, job.kind, job.day, job.periodKey, job.scheduledAt])
      }
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

  async finishReportJob(id: string, token: string, status: 'succeeded' | 'failed' | 'skipped', error: string | null = null): Promise<void> {
    await this.pool.query(`UPDATE workbench.report_jobs SET status=$3,last_error=$4,finished_at=now(),lease_until=NULL,
      next_attempt_at=now()+make_interval(mins=>least(60,5*attempts)) WHERE id=$1 AND lease_token=$2`, [id, token, status, error])
  }

  async renewReportJob(id: string, token: string): Promise<void> {
    await this.pool.query("UPDATE workbench.report_jobs SET lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_token=$2 AND status='running'", [id, token])
  }

  async retryReportJob(id: string): Promise<boolean> {
    return Boolean((await this.pool.query("UPDATE workbench.report_jobs SET status='pending',next_attempt_at=now(),last_error=NULL WHERE id=$1 AND status IN ('failed','skipped') RETURNING id", [id])).rowCount)
  }

  async reportJobs(): Promise<ReportJob[]> {
    return (await this.pool.query('SELECT * FROM workbench.report_jobs ORDER BY scheduled_at DESC LIMIT 30')).rows.map(jobFromRow)
  }
}
