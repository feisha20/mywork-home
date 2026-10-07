import { useEffect, useState } from 'react'
import type { CollectorKind, PathCheckResult, SourcePathCheck } from '../../shared/settings'
import { pathCheckSchema } from '../../shared/settings'
import { checkChannelPaths } from '../data/apiRepository'
import { Icon } from './Icon'

const labels: Record<SourcePathCheck['status'], string> = {
  ready: '可读取', empty: '暂无记录', missing: '目录不存在', unreadable: '无法读取', unmounted: '未授权访问',
}

function fileSummary(entry: SourcePathCheck, collector: CollectorKind) {
  if (entry.status === 'ready') return collector === 'zcode' ? '已找到会话数据库' : `已找到${entry.limited ? '至少' : ''} ${entry.recordFiles} 个会话文件`
  if (entry.status === 'empty') return entry.limited ? '本次检查范围内未找到会话文件，请核对目录' : '尚未找到会话文件，请核对目录或先创建会话'
  if (entry.status === 'unmounted') return '工作台尚未获准访问此目录，请在部署配置中添加该目录后重试'
  if (entry.status === 'missing') return '找不到此目录，请检查本机路径'
  return '无法读取目录或会话文件，请检查访问权限'
}

export function SourcePathDetails({ collector, paths, refreshVersion = 0 }: { collector: CollectorKind; paths: string[]; refreshVersion?: number }) {
  const [result, setResult] = useState<{ key: string; data: PathCheckResult } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [version, setVersion] = useState(0)
  // 仅目录或格式改变时重新核对，修改名称和排序不会触发重复扫描。
  const key = JSON.stringify([collector, paths.map((path) => path.trim()).filter(Boolean), version, refreshVersion])
  const parsed = pathCheckSchema.safeParse({ collector, paths: paths.map((path) => path.trim()).filter(Boolean) })
  useEffect(() => {
    const [format, values] = JSON.parse(key) as [CollectorKind, string[]]
    if (!pathCheckSchema.safeParse({ collector: format, paths: values }).success || !values.length) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void checkChannelPaths(format, values, controller.signal).then((data) => { if (!controller.signal.aborted) { setResult({ key, data }); setError(null) } })
        .catch((cause) => { if (!controller.signal.aborted) setError({ key, message: cause instanceof Error ? cause.message : '目录核对失败，请重试' }) })
    }, 300)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [key])
  if (!parsed.success) return <p className="settings-path-error" role="alert">{parsed.error.issues[0]?.message}</p>
  if (!parsed.data.paths.length) return null
  const current = result?.key === key ? result.data : null
  const failure = error?.key === key ? error.message : null
  return <section className="settings-path-details" aria-label="本机目录与读取状态" aria-busy={!current && !failure}>
    <header><strong>目录核对</strong><button type="button" className="settings-text-button" disabled={!current && !failure} onClick={() => setVersion((value) => value + 1)}><Icon name="refresh" />重新核对</button></header>
    {failure ? <p className="settings-path-error" role="alert">{failure}</p> : !current ? <p className="settings-path-pending" role="status">正在检查本机目录与会话文件…</p> : <ul>
      {current.paths.map((entry, index) => <li className={`settings-path-card is-${entry.status}`} key={`${entry.inputPath}-${index}`}>
        <div className="settings-path-card-heading"><span>目录 {index + 1}</span><span className={`settings-path-status is-${entry.status}`}>{entry.status === 'ready' && <Icon name="check" />}{entry.limited && !entry.recordFiles ? '待核对' : labels[entry.status]}</span></div>
        <dl>
          <div><dt>本机目录</dt><dd>{entry.hostPath ? <code>{entry.hostPath}</code> : <span className="settings-path-unknown">暂时无法识别本机目录，请重新扫描或检查目录配置</span>}</dd></div>
        </dl>
        <p>{fileSummary(entry, collector)}</p>
      </li>)}
    </ul>}
  </section>
}
