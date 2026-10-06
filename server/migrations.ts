import type { Pool } from 'pg'

const migrations = [{ version: 1, sql: `
CREATE TABLE workbench.tasks (
 id text PRIMARY KEY, reference text NOT NULL, source text NOT NULL,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 created_at timestamptz NOT NULL, completed_at timestamptz,
 project_path text NOT NULL DEFAULT '', status_origin text NOT NULL DEFAULT 'ai',
 evidence jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_completed_idx ON workbench.tasks(completed_at);
CREATE TABLE workbench.source_cursors (
 path text PRIMARY KEY, source text NOT NULL, inode text NOT NULL,
 byte_offset bigint NOT NULL, context jsonb NOT NULL, modified_at bigint NOT NULL
);
CREATE TABLE workbench.source_sessions (
 id text PRIMARY KEY, source text NOT NULL, session_id text NOT NULL,
 project_path text NOT NULL, parent_session_id text, updated_at timestamptz NOT NULL
);
CREATE TABLE workbench.source_messages (
 id text PRIMARY KEY, session_key text NOT NULL REFERENCES workbench.source_sessions(id),
 source text NOT NULL, session_id text NOT NULL, root_session_id text NOT NULL,
 project_path text NOT NULL, role text NOT NULL, occurred_at timestamptz NOT NULL,
 body text NOT NULL, extracted boolean NOT NULL DEFAULT false
);
CREATE INDEX messages_pending_idx ON workbench.source_messages(extracted, occurred_at);
CREATE TABLE workbench.extraction_batches (
 id text PRIMARY KEY, session_key text NOT NULL, message_ids jsonb NOT NULL,
 status text NOT NULL, attempts integer NOT NULL DEFAULT 0, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workbench.sync_runs (
 id text PRIMARY KEY, data jsonb NOT NULL, started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workbench.settings (key text PRIMARY KEY, value text NOT NULL);
` }, { version: 2, sql: `
ALTER TABLE workbench.tasks ADD COLUMN recorded_at timestamptz;
UPDATE workbench.tasks SET recorded_at=coalesce(
 (SELECT max((entry->>'timestamp')::timestamptz) FROM jsonb_array_elements(evidence) entry),
 completed_at,created_at
) WHERE source IN ('codex','claude','workbuddy');
CREATE INDEX tasks_recorded_idx ON workbench.tasks(recorded_at);
` }, { version: 3, sql: `
ALTER TABLE workbench.tasks ADD COLUMN deleted_at timestamptz;
` }, { version: 4, sql: `
CREATE TABLE workbench.daily_reports (
 day date PRIMARY KEY, data jsonb NOT NULL,
 revision integer NOT NULL CHECK (revision > 0), updated_at timestamptz NOT NULL DEFAULT now()
);
` }, { version: 5, sql: `
CREATE TABLE workbench.record_failures (
 path text PRIMARY KEY, source text NOT NULL, fingerprint text NOT NULL,
 attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 2),
 last_run_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
` }, { version: 6, sql: `
CREATE TABLE workbench.periodic_reports (
 type text NOT NULL CHECK(type IN ('weekly','monthly')), period_key text NOT NULL,
 data jsonb NOT NULL, revision integer NOT NULL CHECK(revision > 0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(type,period_key)
);
CREATE TABLE workbench.report_jobs (
 id text PRIMARY KEY, kind text NOT NULL, day date NOT NULL, period_key text NOT NULL,
 scheduled_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 last_error text, finished_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token text
);
CREATE INDEX report_jobs_pending_idx ON workbench.report_jobs(status,next_attempt_at,scheduled_at);
ALTER TABLE workbench.tasks ADD COLUMN evidence_stale boolean NOT NULL DEFAULT false;
ALTER TABLE workbench.source_messages ADD COLUMN origin_key text;
ALTER TABLE workbench.source_messages ADD COLUMN source_path text;
CREATE INDEX messages_source_path_idx ON workbench.source_messages(source_path);
ALTER TABLE workbench.source_messages ADD COLUMN valid boolean NOT NULL DEFAULT true;
ALTER TABLE workbench.source_messages ADD COLUMN body_revision integer NOT NULL DEFAULT 1;
ALTER TABLE workbench.source_messages ADD COLUMN invalid_reason text;
CREATE INDEX messages_origin_idx ON workbench.source_messages(source,session_id,origin_key);
CREATE INDEX messages_active_pending_idx ON workbench.source_messages(source,occurred_at,id) WHERE valid AND NOT extracted;
CREATE INDEX tasks_log_day_idx ON workbench.tasks(((CASE WHEN source IN ('manual','zentao') THEN completed_at ELSE coalesce(recorded_at,completed_at,created_at) END AT TIME ZONE 'Asia/Shanghai')::date)) WHERE deleted_at IS NULL;
CREATE INDEX tasks_pending_idx ON workbench.tasks(created_at DESC,id) WHERE deleted_at IS NULL AND source IN ('manual','zentao') AND completed_at IS NULL;
CREATE INDEX tasks_updated_idx ON workbench.tasks(updated_at DESC);
CREATE INDEX daily_reports_updated_idx ON workbench.daily_reports(updated_at DESC);
CREATE INDEX periodic_reports_updated_idx ON workbench.periodic_reports(updated_at DESC);
CREATE INDEX tasks_project_activity_idx ON workbench.tasks(project_path,updated_at) WHERE deleted_at IS NULL;
` }]

export async function migrate(pool: Pool) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(73921001)')
    await client.query('CREATE SCHEMA IF NOT EXISTS workbench')
    await client.query('CREATE TABLE IF NOT EXISTS workbench.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const migration of migrations) {
      const applied = await client.query('SELECT 1 FROM workbench.schema_migrations WHERE version=$1', [migration.version])
      if (applied.rowCount) continue
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO workbench.schema_migrations(version) VALUES($1)', [migration.version])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(73921001)') }
    finally { client.release() }
  }
}
