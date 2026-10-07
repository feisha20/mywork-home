import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '../domain/workbench'
import { createTaskNotificationTracker } from '../domain/taskNotifications'

const preferenceKey = 'workbench-task-notifications'
const deliveredKey = 'workbench-task-notifications-delivered'
function readPreference() {
  try { return localStorage.getItem(preferenceKey) === 'enabled' } catch { return false }
}
function supported() {
  return window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator
}
async function notificationRegistration() {
  await navigator.serviceWorker.register('/notifications-sw.js')
  return navigator.serviceWorker.ready
}

export function useTaskNotifications() {
  const [enabled, setEnabled] = useState(readPreference)
  const [permission, setPermission] = useState<NotificationPermission>(() => supported() ? Notification.permission : 'default')
  const [requesting, setRequesting] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const enabledRef = useRef(enabled)
  const tracker = useRef(createTaskNotificationTracker())
  const available = supported()
  const active = enabled && available && permission === 'granted'
  enabledRef.current = enabled

  useEffect(() => {
    const update = () => {
      setEnabled(readPreference())
      if (supported()) setPermission(Notification.permission)
    }
    window.addEventListener('focus', update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('storage', update)
    }
  }, [])

  const canNotify = useCallback(() => enabledRef.current && supported() && Notification.permission === 'granted', [])
  const notify = useCallback((tasks: readonly Task[]) => {
    const fresh = tracker.current(tasks)
    if (!canNotify() || !fresh.length) return
    void (async () => {
      const registration = await notificationRegistration()
      // 同一浏览器的多个工作台窗口共享去重记录，通知失败不记为已发送。
      const deliver = async () => {
        if (!canNotify()) return
        let delivered: string[] = []
        try {
          const saved: unknown = JSON.parse(localStorage.getItem(deliveredKey) ?? '[]')
          if (Array.isArray(saved)) delivered = saved.filter((id): id is string => typeof id === 'string')
        } catch { /* 缓存不可用时仍可在当前页面去重。 */ }
        const incoming = fresh.filter((task) => !delivered.includes(task.id))
        if (!incoming.length) return
        await registration.showNotification(incoming.length === 1 ? `${incoming[0].scheduledPlan ? '计划任务' : '禅道'}新增待办` : `新增 ${incoming.length} 条待办`, {
          body: incoming.slice(0, 3).map((task) => `${task.reference} · ${task.title}`).join('\n')
            + (incoming.length > 3 ? `\n另有 ${incoming.length - 3} 条，请打开工作台查看` : ''),
          icon: '/icons/workbench-192.png',
          tag: `workbench-tasks-${incoming.map((task) => task.id).join('-')}`,
        })
        try { localStorage.setItem(deliveredKey, JSON.stringify([...delivered, ...incoming.map((task) => task.id)].slice(-1000))) }
        catch { /* 系统通知成功，不因缓存写入失败打断工作台。 */ }
      }
      if (navigator.locks) await navigator.locks.request('workbench-task-notifications', deliver)
      else await deliver()
    })().catch(() => setFeedback('通知发送失败，请检查浏览器及 Mac 的通知权限'))
  }, [canNotify])

  async function toggle() {
    setFeedback(null)
    if (enabled) {
      enabledRef.current = false; setEnabled(false)
      try { localStorage.setItem(preferenceKey, 'disabled') } catch { /* 本次页面仍可关闭通知。 */ }
      return
    }
    if (!available) { setFeedback('请通过 HTTPS 或本机 localhost 地址打开支持通知的浏览器'); return }
    setRequesting(true)
    try {
      // 权限申请直接由用户点击触发，兼容 Safari 的用户手势要求。
      const granted = await Notification.requestPermission()
      setPermission(granted)
      if (granted !== 'granted') {
        setFeedback(granted === 'denied' ? '通知权限已拒绝，请在浏览器和 Mac 通知设置中允许工作台通知' : '尚未允许通知，可再次点击开启')
        return
      }
      await notificationRegistration()
      enabledRef.current = true; setEnabled(true)
      try { localStorage.setItem(preferenceKey, 'enabled') }
      catch { setFeedback('通知已开启，但浏览器无法保存偏好，重新打开后需再次开启') }
    } catch { setFeedback('通知开启失败，请检查浏览器及 Mac 的通知权限') }
    finally { setRequesting(false) }
  }

  return { enabled, active, requesting, canNotify, notify, toggle,
    description: feedback ?? (!available ? '需要支持通知的浏览器及 HTTPS 或 localhost' : enabled && permission === 'denied'
      ? '权限已被阻止，请在浏览器与 Mac 设置中允许' : active
        ? '禅道与计划任务提醒已开启，关闭工作台后停止'
        : '提醒禅道与计划任务新增待办，需保持工作台打开') }
}
