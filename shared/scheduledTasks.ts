import { z } from 'zod'

export const scheduleLabels = { daily: '每天', weekdays: '工作日（周一至周五）', weekly: '每周', monthly: '每月', quarterly: '每季度', yearly: '每年' } as const
export const scheduledTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  frequency: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'quarterly', 'yearly']),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekday: z.number().int().min(1).max(7),
  day: z.number().int().min(1).max(31),
  month: z.number().int().min(1).max(12),
  quarterMonth: z.number().int().min(1).max(3),
  startDate: z.iso.date(), endDate: z.iso.date().nullable(),
  enabled: z.boolean(), isPersonal: z.boolean(),
}).strict().refine((value) => !value.endDate || value.endDate >= value.startDate, { message: '结束日期不能早于开始日期', path: ['endDate'] })

export type ScheduledTaskInput = z.infer<typeof scheduledTaskSchema>
export interface ScheduledTaskPlan extends ScheduledTaskInput { id: string; nextAt: string | null; createdAt: string }

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
export function shanghaiDay(date: Date): string { return dayFormatter.format(date) }

// 按北京时间的日历日计算，避免依赖服务器时区。31 日在短月落到月末。
export function nextOccurrence(plan: ScheduledTaskInput, from: Date): string | null {
  if (!plan.enabled) return null
  const firstDay = [shanghaiDay(from), plan.startDate].sort().at(-1)!
  const cursor = new Date(`${firstDay}T00:00:00Z`)
  for (let index = 0; index < 367; index++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10)
    if (plan.endDate && key > plan.endDate) return null
    const month = cursor.getUTCMonth() + 1, day = cursor.getUTCDate(), weekday = cursor.getUTCDay() || 7
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), month, 0)).getUTCDate()
    const matches = plan.frequency === 'daily' || plan.frequency === 'weekdays' && weekday <= 5
      || plan.frequency === 'weekly' && weekday === plan.weekday
      || plan.frequency === 'monthly' && day === Math.min(plan.day, monthEnd)
      || plan.frequency === 'quarterly' && (month - 1) % 3 + 1 === plan.quarterMonth && day === Math.min(plan.day, monthEnd)
      || plan.frequency === 'yearly' && month === plan.month && day === Math.min(plan.day, monthEnd)
    const instant = new Date(`${key}T${plan.time}:00+08:00`)
    if (matches && instant.getTime() >= from.getTime()) return instant.toISOString()
  }
  return null
}

export function scheduleDescription(plan: ScheduledTaskInput): string {
  const prefix = plan.frequency === 'weekly' ? `每周${['一', '二', '三', '四', '五', '六', '日'][plan.weekday - 1]}`
    : plan.frequency === 'monthly' ? `每月 ${plan.day} 日`
    : plan.frequency === 'quarterly' ? `每季度第 ${plan.quarterMonth} 个月 ${plan.day} 日`
    : plan.frequency === 'yearly' ? `每年 ${plan.month} 月 ${plan.day} 日` : scheduleLabels[plan.frequency]
  return `${prefix} ${plan.time}`
}
