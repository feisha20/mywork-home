import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Task } from '../src/domain/workbench.js';
import { dateKey } from '../src/domain/workbench.js';
import type { ManagementBatch, ManagementScope, ManagementTask, ManagementTaskQuery, ManagementOverview, ZentaoManagementSettings } from '../shared/zentaoManagement.js';
import { evaluateManagement, storyRuleIds } from './zentaoManagement.js';
import { excludePersonalReportItems } from '../shared/dailyReports.js';
interface StoredScope {
  scope: ManagementScope;
  metrics: ManagementOverview['metrics'][number];
  members: ManagementOverview['members'];
}
export const visibleManagementSql = "(management IS NULL OR completed_at IS NOT NULL OR (management->>'handlingState'='pending' AND management->>'riskState'='active'))";
export class ZentaoManagementStore {
  constructor(private pool: Pool, private mapTask: (row: any) => Task) { }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    finally {
      client.release();
    }
  }
  async trackedIds(instance: string, account: string): Promise<string[]> {
    const result = await this.pool.query('SELECT execution_id FROM workbench.zentao_management_scopes WHERE instance=$1 AND account=$2', [instance, account]);
    return result.rows.map((row) => row.execution_id);
  }
  async markFailed(instance: string, account: string, message: string) {
    await this.pool.query('INSERT INTO workbench.zentao_management_status(instance,account,data) VALUES($1,$2,$3) ' +
      'ON CONFLICT(instance,account) DO UPDATE SET data=workbench.zentao_management_status.data || excluded.data,updated_at=now()', [instance, account, JSON.stringify({ issues: [message], lastAttemptAt: new Date().toISOString() })]);
    await this.pool.query("UPDATE workbench.tasks SET management=jsonb_set(management,'{stale}','true'),updated_at=now() " +
      "WHERE management->>'instance'=$1 AND management->>'account'=$2 AND management->>'riskState'='active'", [instance, account]);
    await this.pool.query("UPDATE workbench.zentao_management_scopes SET data=jsonb_set(data,'{metrics}',data->'metrics' || " +
      "jsonb_build_object('incomplete',true,'health',CASE WHEN data->'metrics'->>'health'='red' THEN 'red' ELSE 'gray' END,'issues',jsonb_build_array($3::text))),updated_at=now() WHERE instance=$1 AND account=$2", [instance, account, message]);
  }
  async apply(batch: ManagementBatch, settings: ZentaoManagementSettings) {
    const previousRows = await this.pool.query('SELECT execution_id,data FROM workbench.zentao_management_scopes WHERE instance=$1 AND account=$2', [batch.instance, batch.account]);
    const previous = new Map<string, StoredScope>(previousRows.rows.map((row) => [row.execution_id, row.data]));
    // 评审首次观察时间跨同步和重启保存；用例版本或状态变化后重新计时。
    for (const scope of batch.scopes)
      for (const testcase of scope.cases) {
        const old = previous.get(scope.execution.id)?.scope.cases.find((entry) => entry.id === testcase.id);
        const submitted = testcase.reviewSubmittedAt && Date.parse(testcase.reviewSubmittedAt) <= Date.parse(batch.collectedAt) ? testcase.reviewSubmittedAt : null;
        testcase.waitSince = testcase.status === 'wait' ? submitted ??
          (old?.status === 'wait' && old.version === testcase.version ? old.waitSince : null) ?? batch.collectedAt : null;
      }
    const evaluation = evaluateManagement(batch, settings);
    const activeOwners = await this.pool.query("SELECT DISTINCT management->>'executionId' AS id FROM workbench.tasks WHERE management->>'instance'=$1 AND management->>'account'=$2 AND management->>'riskState'='active'", [batch.instance, batch.account]);
    const owners = new Set([...batch.scopes.map((scope) => scope.execution.id), ...evaluation.risks.map((risk) => risk.executionId), ...activeOwners.rows.map((row) => row.id as string)]);
    let totalCreated = 0, totalUpdated = 0;
    const saveIssues: string[] = [];
    // 冲刺独立提交，某个冲刺保存失败不会回滚其他已采集结果。
    for (const owner of owners) {
      try {
        const counts = await this.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['zentao-management:' + batch.instance + ':' + batch.account]);
          const scope = batch.scopes.find((entry) => entry.execution.id === owner);
          if (scope?.execution.removed) {
            await client.query("UPDATE workbench.zentao_management_scopes SET data=jsonb_set(data,'{scope}',$3::jsonb),updated_at=now() WHERE instance=$1 AND account=$2 AND execution_id=$4", [batch.instance, batch.account, JSON.stringify(scope), owner]);
          }
          if (scope && !scope.execution.removed) {
            const old = previous.get(scope.execution.id), metrics = evaluation.metrics.find((entry) => entry.executionId === scope.execution.id);
            if (!metrics)
              return { created: 0, updated: 0 };
            const storedScope: ManagementScope = { ...scope, execution: scope.execution.status === 'unreadable' && old ? old.scope.execution : scope.execution,
              stories: scope.readable.stories ? scope.stories.map((story) => {
                const previousStory = old?.scope.stories.find((entry) => entry.id === story.id);
                const dates = evaluation.datesByStory[story.id];
                const stale = !!dates && (dates.planned.state === 'unavailable' || dates.actual.state === 'unavailable');
                const releaseDates = stale && previousStory?.releaseDates ? previousStory.releaseDates : dates;
                const dateHistory = previousStory?.dateHistory ?? [];
                if (!stale && dates && previousStory?.releaseDates && JSON.stringify(dates) !== JSON.stringify(previousStory.releaseDates)) {
                  dateHistory.push({ at: batch.collectedAt, dates: previousStory.releaseDates });
                }
                return { ...story, releaseDates, dateHistory, datesStale: stale };
              }) : old?.scope.stories ?? [],
              cases: scope.readable.cases ? scope.cases : old?.scope.cases ?? [],
              testtasks: scope.readable.testtasks ? scope.testtasks : old?.scope.testtasks ?? [],
              bugs: scope.readable.bugs ? scope.bugs : old?.scope.bugs ?? [] };
            const data: StoredScope = { scope: storedScope, metrics: scope.execution.status === 'unreadable' && old
                ? { ...old.metrics, incomplete: true, issues: scope.issues, health: old.metrics.health === 'red' ? 'red' : 'gray' } : metrics,
              members: scope.readable.cases ? evaluation.members.filter((entry) => entry.executionId === scope.execution.id) : old?.members ?? [] };
            if (metrics.incomplete && old) {
              const retained = data.metrics;
              retained.collectedAt = old.metrics.collectedAt;
              retained.unknownMetrics = retained.unknownMetrics?.filter((key) => old.metrics.unknownMetrics?.includes(key));
              if (!scope.readable.stories)
                for (const key of ['storyCount', 'closed'] as const)
                  retained[key] = old.metrics[key];
              if (!scope.readable.stories || scope.stories.some((story) => evaluation.datesByStory[story.id]?.planned.state === 'unavailable' || evaluation.datesByStory[story.id]?.actual.state === 'unavailable')) {
                for (const key of ['released', 'inferredReleased', 'overdue', 'datedReleased', 'onTimeReleased'] as const)
                  retained[key] = old.metrics[key];
              }
              if (!scope.readable.cases || !scope.readable.stories)
                for (const key of ['covered', 'reviewPending'] as const)
                  retained[key] = old.metrics[key];
              if (!scope.readable.bugs)
                retained.severeBugs = old.metrics.severeBugs;
              if (!scope.readable.testtasks)
                retained.openTesttasks = old.metrics.openTesttasks;
              if (old.metrics.health === 'red')
                retained.health = 'red';
            }
            await client.query('INSERT INTO workbench.zentao_management_scopes(instance,account,execution_id,data) VALUES($1,$2,$3,$4) ' +
              'ON CONFLICT(instance,account,execution_id) DO UPDATE SET data=excluded.data,updated_at=now()', [batch.instance, batch.account, scope.execution.id, JSON.stringify(data)]);
            if (!metrics.incomplete)
              await client.query('INSERT INTO workbench.zentao_management_daily(instance,account,execution_id,day,data) VALUES($1,$2,$3,$4,$5) ' +
                'ON CONFLICT(instance,account,execution_id,day) DO UPDATE SET data=excluded.data', [batch.instance, batch.account, scope.execution.id, dateKey(new Date(batch.collectedAt)), JSON.stringify(metrics)]);
          }
          let created = 0, updated = 0;
          for (const risk of evaluation.risks.filter((entry) => entry.executionId === owner)) {
            await client.query('INSERT INTO workbench.zentao_risk_registry(instance,account,risk_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [batch.instance, batch.account, risk.key]);
            const registry = (await client.query('SELECT task_id,occurrence FROM workbench.zentao_risk_registry WHERE instance=$1 AND account=$2 AND risk_key=$3 FOR UPDATE', [batch.instance, batch.account, risk.key])).rows[0];
            const existing = registry.task_id ? (await client.query('SELECT * FROM workbench.tasks WHERE id=$1 FOR UPDATE', [registry.task_id])).rows[0] : null;
            const old: ManagementTask | null = existing?.management ?? null;
            if (!existing || old?.riskState === 'resolved') {
              const id = 'zentao-risk-' + randomUUID(), occurrence = registry.occurrence + 1;
              const metadata: ManagementTask = { ...risk, riskState: 'active', handlingState: 'pending', occurrence,
                firstSeenAt: batch.collectedAt, lastVerifiedAt: batch.collectedAt, handledAt: null, resolvedAt: null, resolutionReason: null, stale: false };
              await client.query("INSERT INTO workbench.tasks(id,reference,source,title,created_at,status_origin,personal_origin,management) VALUES($1,$2,'zentao',$3,$4,'zentao','manual',$5)", [id, 'RISK-' + id.slice(-8).toUpperCase(), risk.action, batch.collectedAt, JSON.stringify(metadata)]);
              await client.query('UPDATE workbench.zentao_risk_registry SET task_id=$4,occurrence=$5 WHERE instance=$1 AND account=$2 AND risk_key=$3', [batch.instance, batch.account, risk.key, id, occurrence]);
              created++;
            }
            else {
              const history = old?.history ?? [];
              if (old?.dates && JSON.stringify(old.dates) !== JSON.stringify(risk.dates))
                history.push({ at: batch.collectedAt, dates: old.dates });
              const metadata = { ...old, ...risk, history, lastVerifiedAt: batch.collectedAt, stale: false };
              await client.query('UPDATE workbench.tasks SET management=$2,title=$3,updated_at=now() WHERE id=$1', [existing.id, JSON.stringify(metadata), old?.handlingState === 'completed' ? existing.title : risk.action]);
              updated++;
            }
          }
          const currentKeys = new Set(evaluation.risks.map((entry) => entry.key)), evaluated = new Set(evaluation.evaluatedKeys);
          const active = await client.query("SELECT * FROM workbench.tasks WHERE management->>'instance'=$1 AND management->>'account'=$2 " +
            "AND management->>'riskState'='active' AND management->>'executionId'=$3 ORDER BY id FOR UPDATE", [batch.instance, batch.account, owner]);
          for (const row of active.rows) {
            const metadata: ManagementTask = row.management;
            if (currentKeys.has(metadata.key))
              continue;
            const storyId = storyRuleIds.some((id) => id === metadata.ruleId) ? metadata.key.slice(metadata.ruleId.length + 1) : undefined;
            const absent = storyRuleIds.some((id) => id === metadata.ruleId) && !!storyId && !evaluation.presentStoryIds.includes(storyId) &&
              metadata.scopeIds.every((id) => evaluation.completeScopeIds.includes(id));
            if (evaluated.has(metadata.key) || absent) {
              const dates = storyId ? evaluation.datesByStory[storyId] : undefined;
              if (metadata.dates && dates && JSON.stringify(metadata.dates) !== JSON.stringify(dates)) {
                metadata.history = [...metadata.history ?? [], { at: batch.collectedAt, dates: metadata.dates }];
              }
              metadata.dates = dates ?? metadata.dates;
              metadata.riskState = 'resolved';
              metadata.resolvedAt = batch.collectedAt;
              metadata.lastVerifiedAt = batch.collectedAt;
              metadata.resolutionReason = metadata.ruleId === 'release'
                ? dates?.actual.state === 'valid' ? '已取得上线节点' : '计划或关联范围已调整' : absent ? '已确认移出监控范围' : '触发条件已解除';
              metadata.stale = false;
            }
            else
              metadata.stale = true;
            await client.query('UPDATE workbench.tasks SET management=$2,updated_at=now() WHERE id=$1', [row.id, JSON.stringify(metadata)]);
            updated++;
          }
          return { created, updated };
        });
        totalCreated += counts.created;
        totalUpdated += counts.updated;
      }
      catch {
        saveIssues.push('冲刺 ' + owner + ' 保存失败，保留上次判断');
        await this.pool.query("UPDATE workbench.tasks SET management=jsonb_set(management,'{stale}','true'),updated_at=now() WHERE management->>'instance'=$1 AND management->>'account'=$2 AND management->>'executionId'=$3 AND management->>'riskState'='active'", [batch.instance, batch.account, owner]);
      }
    }
    const issues = [...new Set([...batch.issues, ...saveIssues, ...evaluation.metrics.flatMap((entry) => entry.issues)])];
    await this.pool.query('INSERT INTO workbench.zentao_management_status(instance,account,data) VALUES($1,$2,$3) ' +
      'ON CONFLICT(instance,account) DO UPDATE SET data=excluded.data,updated_at=now()', [batch.instance, batch.account, JSON.stringify({ issues, lastUpdatedAt: batch.collectedAt })]);
    return { created: totalCreated, updated: totalUpdated, issues };
  }
  async setAction(id: string, action: 'complete' | 'ignore' | 'restore'): Promise<Task | null> {
    return this.transaction(async (client) => {
      const row = (await client.query('SELECT * FROM workbench.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!row)
        return null;
      const metadata: ManagementTask | null = row.management;
      if (!metadata)
        throw Object.assign(new Error('该操作仅适用于禅道管理事项'), { statusCode: 409 });
      if (metadata.riskState === 'resolved')
        throw Object.assign(new Error('风险已解除，无需恢复或处理'), { statusCode: 409 });
      const state = action === 'complete' ? 'completed' : action === 'ignore' ? 'ignored' : 'pending';
      if (state === metadata.handlingState)
        return this.mapTask(row);
      if (row.completed_at && state !== 'completed') {
        const reports = await client.query("SELECT day,data,revision FROM workbench.daily_reports WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(data->'items') item WHERE item->'taskIds' ? $1) ORDER BY day FOR UPDATE", [id]);
        for (const report of reports.rows) {
          const data = excludePersonalReportItems(report.data, new Set([id]));
          await client.query('UPDATE workbench.daily_reports SET data=$2,revision=revision+1,updated_at=now() WHERE day=$1',
            [report.day, JSON.stringify({ ...data, revision: report.revision + 1 })]);
          await client.query("UPDATE workbench.periodic_reports SET data=data || jsonb_build_object('needsRefresh',true,'revision',revision+1),revision=revision+1,updated_at=now() WHERE data->>'startDate'<=$1 AND data->>'endDate'>=$1",
            [dateKey(new Date(report.day))]);
        }
      }
      metadata.handlingState = state;
      metadata.handledAt = state === 'pending' ? null : new Date().toISOString();
      const result = await client.query("UPDATE workbench.tasks SET management=$2,completed_at=$3,status_origin='manual',title=$4,updated_at=now() WHERE id=$1 RETURNING *", [id, JSON.stringify(metadata), state === 'completed' ? metadata.handledAt : null,
        state === 'completed' ? ('已处理：' + metadata.action).slice(0, 300) : metadata.action]);
      return this.mapTask(result.rows[0]);
    });
  }
  async page(input: ManagementTaskQuery, identity?: {
    instance: string;
    account: string;
  }) {
    const state = input.state ?? 'pending', limit = input.limit ?? 50, offset = input.offset ?? 0;
    const where = "management IS NOT NULL AND deleted_at IS NULL AND " +
      (state === 'resolved' ? "management->>'riskState'='resolved' AND $1::text IS NOT NULL" : "management->>'handlingState'=$1" +
        (state === 'pending' ? " AND management->>'riskState'='active'" : '')) +
      " AND ($2::text IS NULL OR management->>'projectId'=$2) AND ($3::text IS NULL OR management->'scopeIds' ? $3) " +
      "AND ($4::text IS NULL OR management->>'severity'=$4) AND ($5::text IS NULL OR management->>'instance'=$5) AND ($6::text IS NULL OR management->>'account'=$6)";
    const params = [state, input.projectId ?? null, input.executionId ?? null, input.severity ?? null, identity?.instance ?? null, identity?.account ?? null];
    const count = await this.pool.query('SELECT count(*)::int AS count FROM workbench.tasks WHERE ' + where, params);
    const rows = await this.pool.query('SELECT * FROM workbench.tasks WHERE ' + where +
      " ORDER BY CASE management->>'severity' WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END,created_at DESC,id LIMIT $7 OFFSET $8", [...params, limit, offset]);
    return { tasks: rows.rows.map(this.mapTask), total: count.rows[0].count, limit, offset };
  }
  async overview(instance: string, account: string, enabled = true): Promise<ManagementOverview> {
    const results = await Promise.all([
      this.pool.query('SELECT data FROM workbench.zentao_management_scopes WHERE instance=$1 AND account=$2 ORDER BY execution_id', [instance, account]),
      this.pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day,data FROM workbench.zentao_management_daily WHERE instance=$1 AND account=$2 AND day>=(now() AT TIME ZONE 'Asia/Shanghai')::date-30 ORDER BY day,execution_id", [instance, account]),
      this.pool.query('SELECT data FROM workbench.zentao_management_status WHERE instance=$1 AND account=$2', [instance, account]),
    ]);
    const scopes = results[0].rows.map((row) => row.data as StoredScope).filter((entry) => !entry.scope.execution.removed), status = results[2].rows[0]?.data;
    return { metrics: scopes.map((entry) => entry.metrics), members: scopes.flatMap((entry) => entry.members),
      history: results[1].rows.map((row) => ({ day: row.day, metrics: row.data })), issues: status?.issues ?? [], enabled,
      lastUpdatedAt: status?.lastUpdatedAt ?? null };
  }
}
