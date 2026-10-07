import type { Task } from '../domain/workbench'

export function ManagementDetails({ task }: { task: Task }) {
  const management = task.management
  if (!management) return null
  const dates = management.dates
  const displayDate = (value: NonNullable<typeof dates>['planned']) => value.state === 'valid' ? value.value :
    value.state === 'unavailable' ? '待更新' : value.state === 'invalid' ? '待核对：' + (value.value ?? '日期无效') : '未填写'
  return <div className="management-details">
    <p className="management-context"><span className={'management-level is-' + management.severity}>
      {management.severity === 'red' ? '需优先跟进' : management.severity === 'yellow' ? '需关注' : '日期待核对'}</span>
      <span>{management.project} · {management.execution}</span></p>
    <p className="management-reason">{management.reason}</p>
    {dates && <dl className="management-dates">
      <div><dt>计划节点</dt><dd>{displayDate(dates.planned)}<small>{dates.planned.sourceLabel}</small></dd></div>
      <div><dt>实际节点</dt><dd>{displayDate(dates.actual)}<small>{dates.actual.sourceLabel}</small></dd></div>
    </dl>}
    <details className="management-evidence"><summary>查看依据与关联对象（{management.entities.length}）</summary>
      <ul>{management.entities.map((entity) => <li key={entity.type + entity.id}>
        <a href={/^https?:\/\//.test(entity.url) ? entity.url : undefined} target="_blank" rel="noopener noreferrer">{entity.title}</a>
        {entity.owner && <span> · {entity.owner}</span>}
      </li>)}</ul>
      <p>最近核实：{new Date(management.lastVerifiedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
        {management.stale ? ' · 数据待更新' : ''}</p>
      {management.resolutionReason && <p>收起原因：{management.resolutionReason}</p>}
      {!!management.history?.length && <ul>{management.history.map((entry, index) => <li key={index}>
        {new Date(entry.at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })} 前的日期依据：
        计划 {entry.dates.planned.value ?? '未填写'}（{entry.dates.planned.sourceLabel}），
        实际 {entry.dates.actual.value ?? '未填写'}（{entry.dates.actual.sourceLabel}）
      </li>)}</ul>}
    </details>
  </div>
}
