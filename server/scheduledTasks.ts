import { randomUUID } from 'node:crypto'
import type { Store } from './store.js'
import { nextOccurrence, type ScheduledTaskInput, type ScheduledTaskPlan } from '../shared/scheduledTasks.js'

function fromRow(row: any): ScheduledTaskPlan {
  return { ...row.data, id: row.id, nextAt: row.next_at ? new Date(row.next_at).toISOString() : null, createdAt: new Date(row.created_at).toISOString() }
}

export class ScheduledTasks {
  private timer?: ReturnType<typeof setTimeout>
  private active?: Promise<void>
  private stopped = false
  constructor(private readonly store: Store) {}
  async list(): Promise<ScheduledTaskPlan[]> {
    const { rows } = await this.store.pool.query('SELECT * FROM workbench.scheduled_tasks ORDER BY created_at DESC,id')
    return rows.map(fromRow)
  }
  async save(input: ScheduledTaskInput, id?: string, now = new Date()): Promise<ScheduledTaskPlan | null> {
    const next = nextOccurrence(input, now)
    const { rows } = id
      ? await this.store.pool.query('UPDATE workbench.scheduled_tasks SET data=$2,next_at=$3,updated_at=now() WHERE id=$1 RETURNING *', [id, JSON.stringify(input), next])
      : await this.store.pool.query('INSERT INTO workbench.scheduled_tasks(id,data,next_at) VALUES($1,$2,$3) RETURNING *', [randomUUID(), JSON.stringify(input), next])
    return rows[0] ? fromRow(rows[0]) : null
  }
  async remove(id: string): Promise<boolean> {
    return !!(await this.store.pool.query('DELETE FROM workbench.scheduled_tasks WHERE id=$1', [id])).rowCount
  }
  async generateDue(now = new Date()): Promise<void> {
    await this.store.transaction(async (client) => {
      // 行锁串行化计划编辑、删除和生成；多实例跳过其他实例正在处理的计划。
      const { rows } = await client.query('SELECT * FROM workbench.scheduled_tasks WHERE next_at <= $1 ORDER BY next_at,id LIMIT 50 FOR UPDATE SKIP LOCKED', [now])
      for (const row of rows) {
        const plan = fromRow(row)
        let next = plan.nextAt
        // 分批补齐，限制一次事务的大小，游标与生成待办同时提交。
        for (let count = 0; next && next <= now.toISOString() && count < 100; count++) {
          const id = randomUUID()
          const occurrence = await client.query(`INSERT INTO workbench.scheduled_task_occurrences(plan_id,scheduled_at,task_id)
            VALUES($1,$2,$3) ON CONFLICT(plan_id,scheduled_at) DO NOTHING RETURNING task_id`, [plan.id, next, id])
          if (occurrence.rowCount) {
            await client.query(`INSERT INTO workbench.tasks(id,reference,source,title,created_at,status_origin,is_personal,personal_origin,scheduled_plan)
              VALUES($1,$2,'manual',$3,$4,'manual',$5,'manual',$6)`,
            [id, `PLAN-${id.slice(0, 8).toUpperCase()}`, plan.title, next, plan.isPersonal, JSON.stringify({ id: plan.id, scheduledAt: next })])
          }
          next = nextOccurrence(plan, new Date(new Date(next).getTime() + 1))
        }
        await client.query('UPDATE workbench.scheduled_tasks SET next_at=$2,updated_at=now() WHERE id=$1', [plan.id, next])
      }
    })
  }
  start() {
    const tick = () => {
      if (this.stopped) return
      this.active = this.generateDue().catch(() => console.error('计划任务生成失败，将在下一次检查时重试')).finally(() => {
        if (!this.stopped) { this.timer = setTimeout(tick, 30_000); this.timer.unref?.() }
      })
    }
    tick()
  }
  async close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.active }
}
