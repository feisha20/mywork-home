import { canManualComplete, recordTimestamp, sourceInfo } from '../domain/workbench'
import type { Task } from '../domain/workbench'
import { Icon } from './Icon'
import { TaskEvidence } from './TaskEvidence'
import { TaskReference, ZentaoTaskDetails } from './TaskReference'
import type { DailyReport } from '../../shared/contracts'
import { isRecordInReport } from '../../shared/dailyReports'
import { PersonalTaskToggle } from './PersonalTaskToggle'
import { ManagementDetails } from './ManagementDetails'

const logTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
export interface LogRecordsProps {
  records: Task[]
  dailyReport?: DailyReport | null
  recentId?: string | null
  onReopen: (task: Task) => void
  onTogglePersonal: (task: Task) => Promise<Task>
  disabled: boolean
}

export function LogRecords({ records, dailyReport, recentId, onReopen, onTogglePersonal, disabled }: LogRecordsProps) {
  return <div className="daily-item-list">
    {records.map((task) => <article key={task.id} className={`daily-log-card${task.id === recentId ? ' just-arrived' : ''}`}>
      <div className="daily-log-top">
        <div className="daily-log-source-group">
          <span className="daily-log-source">{task.sourceLabel ?? sourceInfo(task.source).label}</span>
          <TaskReference task={task} />
        </div>
        <time className="daily-log-time" dateTime={recordTimestamp(task)!}>{logTime.format(new Date(recordTimestamp(task)!))}</time>
      </div>
      <p className="daily-log-text" title={task.title}>{task.title}</p>
      {task.management && <ManagementDetails task={task} />}
      <div className="daily-log-actions">
        <ZentaoTaskDetails task={task} />
        <TaskEvidence task={task} />
        <PersonalTaskToggle task={task} disabled={disabled} onToggle={onTogglePersonal} />
        <span className={`daily-log-report-state ${task.isPersonal ? 'is-excluded' : isRecordInReport(task, dailyReport) ? 'is-organized' : 'is-pending'}`}
          title={task.isPersonal ? '个人事项不会纳入工作日报、周报和月报' : isRecordInReport(task, dailyReport) ? '已整合进这一天保存的日报' : '尚未整理，或内容更新后需要补充整理'}>{task.isPersonal ? '不纳入报告' : isRecordInReport(task, dailyReport) ? '已整理' : '待整理'}</span>
        {canManualComplete(task) && <button className="reopen-task" disabled={disabled} onClick={() => onReopen(task)} aria-label={`恢复为待办：${task.title}`}>恢复待办</button>}
      </div>
    </article>)}
    {records.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="book" /></span><h3>这一天还没有工作日志</h3><p>同步的工作记录会按来源日期自动归档，待办完成后也会进入日志。</p></div>}
  </div>
}
