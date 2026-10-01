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
