// 旧版归档仅在服务器尚无报告时迁移，成功前保留旧缓存以便重试。
export function legacyReportMarkdown(key: string): string | null {
  try {
    const report = JSON.parse(localStorage.getItem('workbench_periodic_reports_cache') ?? '{}')[key]
    return typeof report?.markdown === 'string' && report.markdown.trim() && report.markdown.length <= 100_000 ? report.markdown : null
  } catch { return null }
}
