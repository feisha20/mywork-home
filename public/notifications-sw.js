// 只负责通知展示和点击，不缓存页面与接口。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const workbench = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (workbench) return workbench.focus()
    return self.clients.openWindow('/')
  })())
})
