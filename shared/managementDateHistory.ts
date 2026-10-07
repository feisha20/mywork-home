import type { EffectiveDate, ReleaseDates } from './zentaoManagement.js'

export type ManagementDateHistory = { at: string; dates: ReleaseDates }[]

// JSONB 读取后字段顺序可能改变；只按日期依据的字段内容比较。
const dateValues = (date: EffectiveDate) => [date.state, date.value, date.day, date.timestamp,
  date.precision, date.source, date.sourceLabel, date.fieldPath ?? null]
export function sameReleaseDates(left?: ReleaseDates, right?: ReleaseDates): boolean {
  if (!left || !right) return left === right
  return JSON.stringify([dateValues(left.planned), dateValues(left.actual), left.fallbackExecutionId]) ===
    JSON.stringify([dateValues(right.planned), dateValues(right.actual), right.fallbackExecutionId])
}

export function normalizeManagementDateHistory(history: ManagementDateHistory = [], current?: ReleaseDates): ManagementDateHistory {
  const result: ManagementDateHistory = []
  let next = current
  // 仅合并连续相同的依据，保留 A → B → A 这类真实变更及最近的变更时间。
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    if (!sameReleaseDates(entry.dates, next)) result.push(entry)
    next = entry.dates
  }
  return result.reverse()
}

export function updateManagementDateHistory(history: ManagementDateHistory | undefined,
  previous: ReleaseDates | undefined, current: ReleaseDates | undefined, at: string): ManagementDateHistory {
  const entries = [...history ?? []]
  if (previous && !sameReleaseDates(previous, current)) entries.push({ at, dates: previous })
  return normalizeManagementDateHistory(entries, current)
}
