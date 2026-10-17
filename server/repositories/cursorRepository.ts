import type { Pool } from 'pg'
import type { Cursor, Source } from '../records.js'

export class CursorRepository {
  constructor(private readonly pool: Pool) {}

  async cutoff(): Promise<string> {
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

  async clearRecordFailure(path: string): Promise<void> {
    await this.pool.query('DELETE FROM workbench.record_failures WHERE path=$1', [path])
  }
}
