import { recordTimestamp, requiresManualCompletion, SOURCES } from '../domain/workbench'
import type { Task } from '../domain/workbench'
import { Icon } from './Icon'
import { TaskEvidence } from './TaskEvidence'
import type { DailyReport } from '../../shared/contracts'
import { isRecordInReport } from '../../shared/dailyReports'

const logTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
export interface LogRecordsProps {
  records: Task[]
  dailyReport?: DailyReport | null
  recentId?: string | null
  onReopen: (task: Task) => void
  disabled: boolean
}

export function LogRecords({ records, dailyReport, recentId, onReopen, disabled }: LogRecordsProps) {
  return <div className="daily-item-list">
    {records.map((task) => <article key={task.id} className={`daily-log-card${task.id === recentId ? ' just-arrived' : ''}`}>
      <div className="daily-log-top">
        <div className="daily-log-source-group">
          <span className="daily-log-source">{SOURCES[task.source].label}</span>
          <span className="daily-log-reference">{task.reference}</span>
        </div>
        <time className="daily-log-time" dateTime={recordTimestamp(task)!}>{logTime.format(new Date(recordTimestamp(task)!))}</time>
      </div>
      <p className="daily-log-text" title={task.title}>{task.title}</p>
      <div className="daily-log-actions">
        <TaskEvidence task={task} />
        <span className={`daily-log-report-state ${isRecordInReport(task, dailyReport) ? 'is-organized' : 'is-pending'}`}
          title={isRecordInReport(task, dailyReport) ? '已整合进这一天保存的日报' : '尚未整理，或内容更新后需要补充整理'}>{isRecordInReport(task, dailyReport) ? '已整理' : '待整理'}</span>
        {requiresManualCompletion(task.source) && <button className="reopen-task" disabled={disabled} onClick={() => onReopen(task)} aria-label={`恢复为待办：${task.title}`}>恢复待办</button>}
      </div>
    </article>)}
    {records.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="book" /></span><h3>这一天还没有工作日志</h3><p>同步的工作记录会按来源日期自动归档，待办完成后也会进入日志。</p></div>}
  </div>
}
