import type { Pool, PoolClient } from 'pg'
import type { Task } from '../../src/domain/workbench.js'
import type { ReportJob } from '../../shared/contracts.js'
import { visibleManagementSql } from '../zentaoManagementStore.js'

// 计划待办完成后按计划日期归档；completed_at 始终保留真实完成时间。
export const recordTimestampSql = `CASE WHEN source='manual' AND scheduled_plan IS NOT NULL AND completed_at IS NOT NULL
  THEN coalesce(recorded_at,completed_at) WHEN source IN ('manual','zentao') THEN completed_at
  ELSE coalesce(recorded_at,completed_at,created_at) END`
export const recordDateSql = `(${recordTimestampSql} AT TIME ZONE 'Asia/Shanghai')::date`
export const scheduledRecordTimestampSql = `CASE WHEN source='manual' AND scheduled_plan->>'scheduledAt' IS NOT NULL
  THEN (scheduled_plan->>'scheduledAt')::timestamptz ELSE recorded_at END`
export const taskSummaryColumns = 'id,reference,source,title,created_at,completed_at,recorded_at,project_path,status_origin,is_pinned,is_personal,personal_origin,evidence_stale,zentao,management,scheduled_plan,jsonb_array_length(evidence) AS evidence_count'
export { visibleManagementSql }

export function jobFromRow(row: any): ReportJob {
  return {
    id: row.id,
    kind: row.kind,
    day: new Date(row.day).toISOString().slice(0, 10),
    periodKey: row.period_key,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    status: row.status,
    attempts: row.attempts,
    error: row.last_error,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  }
}

export function taskFromRow(row: any): Task {
  return {
    id: row.id,
    reference: row.reference,
    source: row.source,
    title: row.title,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    projectPath: row.project_path,
    statusOrigin: row.status_origin,
    isPinned: Boolean(row.is_pinned),
    isPersonal: Boolean(row.is_personal),
    personalOrigin: row.personal_origin,
    scheduledPlan: row.scheduled_plan,
    evidence: row.evidence,
    zentao: row.zentao,
    management: row.management,
    evidenceCount: row.evidence_count === undefined ? undefined : Number(row.evidence_count),
    evidenceStale: Boolean(row.evidence_stale),
  }
}

export interface ExtractedItem {
  taskId?: string
  title: string
  status: 'todo' | 'completed'
  isPersonal?: boolean
  evidenceIds: string[]
}

export async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
