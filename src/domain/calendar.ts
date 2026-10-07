// 使用 UTC 计算日历格子，避免宿主机时区和夏令时改变日期。
function key(date: Date) { return date.toISOString().slice(0, 10) }
export function shiftMonth(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number)
  return key(new Date(Date.UTC(year, number - 1 + offset, 1))).slice(0, 7)
}
export function shiftYear(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number)
  return `${year + offset}-${String(number).padStart(2, '0')}`
}
export function calendarDays(month: string): string[] {
  const [year, number] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, number - 1, 1))
  const start = first.getUTCDate() - (first.getUTCDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => key(new Date(Date.UTC(year, number - 1, start + index))))
}
