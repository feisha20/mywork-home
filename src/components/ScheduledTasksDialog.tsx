import { useEffect, useRef, useState, type FormEvent } from 'react'
import { deleteScheduledTask, fetchScheduledTasks, saveScheduledTask } from '../data/apiRepository'
import { nextOccurrence, scheduleDescription, scheduleLabels, shanghaiDay, type ScheduledTaskInput, type ScheduledTaskPlan } from '../../shared/scheduledTasks'
import { Icon } from './Icon'
import { SettingsSelect } from './SettingsSelect'

const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const emptyPlan = (): ScheduledTaskInput => ({ title: '', frequency: 'monthly', time: '09:00', weekday: 5, day: 1, month: 1, quarterMonth: 1, startDate: shanghaiDay(new Date()), endDate: null, enabled: true, isPersonal: false })
const templates: { title: string; frequency: ScheduledTaskInput['frequency']; time?: string }[] = [
  { title: '提交日报', frequency: 'weekdays', time: '17:30' }, { title: '提交周报', frequency: 'weekly', time: '17:30' },
  { title: '提交月报', frequency: 'monthly' }, { title: '提交季度报告', frequency: 'quarterly' },
  { title: '提交自己的 OKR', frequency: 'monthly' }, { title: '审核部门 OKR', frequency: 'monthly' },
]

export function ScheduledTasksDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [plans, setPlans] = useState<ScheduledTaskPlan[]>([])
  const [form, setForm] = useState<ScheduledTaskInput>(emptyPlan)
  const [editingId, setEditingId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deletingId, setDeletingId] = useState<string>()
  const [loadFailed, setLoadFailed] = useState(false)
  useEffect(() => {
    dialogRef.current?.showModal()
    let cancelled = false
    fetchScheduledTasks().then((value) => { if (!cancelled) setPlans(value) }).catch((cause) => {
      if (!cancelled) { setError(cause instanceof Error ? cause.message : '计划加载失败'); setLoadFailed(true) }
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  const patch = <K extends keyof ScheduledTaskInput>(key: K, value: ScheduledTaskInput[K]) => setForm((current) => ({ ...current, [key]: value }))
  const reset = () => { setForm(emptyPlan()); setEditingId(undefined); setError(''); setDeletingId(undefined) }
  const preview = nextOccurrence(form, new Date())
  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试') }
    finally { setBusy(false) }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    void perform(async () => {
      const saved = await saveScheduledTask(form, editingId)
      setPlans((current) => [saved, ...current.filter((plan) => plan.id !== saved.id)])
      reset(); setNotice('计划已保存，到期后会自动出现在待办中。')
    })
  }
  return <dialog className="scheduled-tasks-dialog" ref={dialogRef} aria-labelledby="scheduled-tasks-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <header className="scheduled-tasks-header">
      <div><h2 id="scheduled-tasks-title"><Icon name="calendar" />计划任务</h2><p>把固定要做的事交给日历，到期自动加入待办。</p></div>
      <button type="button" className="scheduled-icon-button" aria-label="关闭计划任务" disabled={busy} onClick={onClose}><Icon name="close" /></button>
    </header>
    {error && <p className="scheduled-message is-error" role="alert">{error}</p>}
    {notice && <p className="scheduled-message" role="status">{notice}</p>}
    <div className="scheduled-tasks-body">
      <section className="scheduled-plans" aria-label="已设定的计划">
        <div className="scheduled-section-heading"><h3>我的计划 <span>{plans.length}</span></h3><button type="button" disabled={busy || loading || loadFailed} onClick={reset}><Icon name="plus" />新建</button></div>
        {loading ? <p role="status">正在加载计划…</p> : loadFailed ? <p className="scheduled-empty">计划加载失败，请关闭后重新打开。</p> : plans.length === 0 ? <p className="scheduled-empty">还没有计划。可以从右侧的常用事项开始，设置适合自己的日期。</p> : plans.map((plan) => <article key={plan.id} className={`scheduled-plan${editingId === plan.id ? ' is-editing' : ''}`}>
          <div className="scheduled-plan-title"><strong>{plan.title}</strong><span className={plan.enabled ? 'is-enabled' : ''}>{!plan.enabled ? '已暂停' : plan.nextAt ? '进行中' : '已结束'}</span></div>
          <p>{scheduleDescription(plan)}{plan.isPersonal ? ' · 个人事项' : ''}</p>
          <small>{plan.nextAt ? `下次：${formatTime(plan.nextAt)}` : plan.enabled ? '没有后续生成日期' : '恢复后从当前时间重新安排'}</small>
          <div className="scheduled-plan-actions">
            <button type="button" disabled={busy} onClick={() => { setEditingId(plan.id); setForm({ title: plan.title, frequency: plan.frequency, time: plan.time, weekday: plan.weekday, day: plan.day, month: plan.month, quarterMonth: plan.quarterMonth, startDate: plan.startDate, endDate: plan.endDate, enabled: plan.enabled, isPersonal: plan.isPersonal }); setError(''); setNotice(''); setDeletingId(undefined) }}>编辑</button>
            <button type="button" disabled={busy} onClick={() => { void perform(async () => {
              const { id, nextAt: _next, createdAt: _created, ...input } = plan
              const saved = await saveScheduledTask({ ...input, enabled: !plan.enabled }, id)
              setPlans((current) => current.map((item) => item.id === id ? saved : item))
              if (editingId === id) reset()
              setNotice(saved.enabled ? '计划已恢复，暂停期间不会补发。' : '计划已暂停，已有待办保留。')
            }) }}> {plan.enabled ? '暂停' : '恢复'}</button>
            <button type="button" disabled={busy} onClick={() => setDeletingId(plan.id)}>删除</button>
          </div>
          {deletingId === plan.id && <div className="scheduled-delete"><p>删除此计划？已有待办和完成记录会保留。</p><button type="button" disabled={busy} onClick={() => { void perform(async () => {
            await deleteScheduledTask(plan.id); setPlans((current) => current.filter((item) => item.id !== plan.id)); setDeletingId(undefined)
            if (editingId === plan.id) reset()
            setNotice('计划已删除，已有待办保留。')
          }) }}>确认删除</button><button type="button" disabled={busy} onClick={() => setDeletingId(undefined)}>取消</button></div>}
        </article>)}
      </section>
      <form className="scheduled-editor" onSubmit={submit}>
        <h3>{editingId ? '编辑计划' : '新建计划'}</h3>
        <fieldset disabled={busy || loading || loadFailed}>
          {!editingId && <div className="scheduled-templates" aria-label="常用事项">{templates.map((template) => <button type="button" key={template.title} onClick={() => { setForm({ ...emptyPlan(), ...template }); setNotice('') }}>{template.title}</button>)}</div>}
          <label>事项名称<input required maxLength={300} value={form.title} onChange={(event) => patch('title', event.target.value)} placeholder="例如：提交自己的 OKR" /></label>
          <div className="scheduled-field-grid">
            <SettingsSelect label="重复周期" value={form.frequency} options={Object.entries(scheduleLabels).map(([value, label]) => ({ value: value as ScheduledTaskInput['frequency'], label }))} disabled={busy || loading || loadFailed} onChange={(value) => patch('frequency', value)} />
            <label>生成时间（北京时间）<input type="time" required value={form.time} onChange={(event) => patch('time', event.target.value)} /></label>
            {form.frequency === 'weekly' && <SettingsSelect label="每周哪一天" value={String(form.weekday)} options={['一', '二', '三', '四', '五', '六', '日'].map((day, index) => ({ value: String(index + 1), label: `星期${day}` }))} disabled={busy || loading || loadFailed} onChange={(value) => patch('weekday', Number(value))} />}
            {form.frequency === 'quarterly' && <SettingsSelect label="季度内月份" value={String(form.quarterMonth)} options={[1, 2, 3].map((month) => ({ value: String(month), label: `第 ${month} 个月` }))} disabled={busy || loading || loadFailed} onChange={(value) => patch('quarterMonth', Number(value))} />}
            {form.frequency === 'yearly' && <SettingsSelect label="月份" value={String(form.month)} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 月` }))} disabled={busy || loading || loadFailed} onChange={(value) => patch('month', Number(value))} />}
            {['monthly', 'quarterly', 'yearly'].includes(form.frequency) && <SettingsSelect label="每月哪一天" value={String(form.day)} options={Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 日${index === 30 ? '（短月取月末）' : ''}` }))} disabled={busy || loading || loadFailed} onChange={(value) => patch('day', Number(value))} />}
            <label>开始日期<input type="date" required value={form.startDate} onChange={(event) => patch('startDate', event.target.value)} /></label>
            <label>结束日期（可选）<input type="date" min={form.startDate} value={form.endDate ?? ''} onChange={(event) => patch('endDate', event.target.value || null)} /></label>
          </div>
          <label className="scheduled-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => patch('enabled', event.target.checked)} />启用计划</label>
          <label className="scheduled-checkbox"><input type="checkbox" checked={form.isPersonal} onChange={(event) => patch('isPersonal', event.target.checked)} />个人事项（完成后不计入工作报告）</label>
          <div className="scheduled-preview"><Icon name="clock" /><span>{preview ? `下次生成：${formatTime(preview)}` : form.enabled ? '该日期范围内没有后续生成时间' : '计划已暂停，不生成待办'}</span></div>
          <p className="scheduled-help">新建、修改或恢复后从当前时间安排；修改只影响后续待办。工作日指周一至周五，不排除法定节假日。月末日期超出当月天数时取月末。</p>
          <div className="scheduled-save"><button type="submit" disabled={!form.title.trim()}>{busy ? '正在保存…' : editingId ? '保存修改' : '创建计划'}</button>{editingId && <button type="button" onClick={reset}>取消编辑</button>}</div>
        </fieldset>
      </form>
    </div>
    <footer className="scheduled-tasks-footer">服务运行时每 30 秒检查一次；停机期间错过的计划会在恢复后补齐。每期独立生成，完成或删除待办不会重复生成。</footer>
  </dialog>
}
