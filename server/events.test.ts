import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchEventStream } from './events.js'
import type { Store } from './store.js'
import type { SyncService } from './sync.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function fixture() {
  const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({})), release: vi.fn() })
  const query = vi.fn(async () => ({ rows: [{ id: 'one', reference: 'ZT-1', title: '新增待办 private-key-123', source: 'zentao' }] }))
  const store = { pool: { connect: vi.fn(async () => client), query }, dataVersion: vi.fn(async () => 'version-2'), latestRun: vi.fn(async () => null) }
  const sync = { realtimeStatus: vi.fn(() => ({ modelRuntime: { coolingModelIds: [] }, harness: { run: null } })) }
  const events = new WorkbenchEventStream(store as unknown as Store, sync as unknown as SyncService, () => ['private-key-123'])
  const response = () => Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn(), destroy: vi.fn(), destroyed: false, writableEnded: false })
  return { client, store, events, response, sync }
}
describe('SSE 服务端连接与资源边界', () => {
  it('多客户端只使用一个 LISTEN 连接，空闲只发心跳且不查询数据库，离开清理定时器', async () => {
    const { events, store, client, response } = fixture()
    await Promise.all([events.ready(), events.ready()])
    expect(store.pool.connect).toHaveBeenCalledOnce()
    expect(client.query).toHaveBeenCalledWith('LISTEN workbench_events')
    const first = response(), second = response()
    events.attach(first as unknown as ServerResponse); events.attach(second as unknown as ServerResponse)
    await vi.advanceTimersByTimeAsync(25000)
    expect(first.write).toHaveBeenLastCalledWith(': heartbeat\n\n')
    expect(store.dataVersion).not.toHaveBeenCalled(); expect(store.pool.query).not.toHaveBeenCalled()
    first.emit('close'); await events.close()
    expect(second.end).toHaveBeenCalledOnce(); expect(client.release).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('合并变更通知并只发送脱敏摘要，不发送证据或完整记录', async () => {
    const { events, client, response, store } = fixture()
    await events.ready(); const res = response(); events.attach(res as unknown as ServerResponse)
    const notify = (payload: object) => client.emit('notification', { channel: 'workbench_events', payload: JSON.stringify(payload) })
    notify({ kind: 'changed' }); notify({ kind: 'changed' }); notify({ kind: 'sync' }); notify({ kind: 'created', id: 'one' })
    await vi.advanceTimersByTimeAsync(60)
    expect(store.dataVersion).toHaveBeenCalledOnce()
    const frames = res.write.mock.calls.flat().join('')
    expect(frames).toContain('event: tasks:created\ndata:')
    expect(frames).toContain('[已隐藏凭证]'); expect(frames).not.toContain('private-key-123')
    expect(frames).toContain('event: workbench:changed'); expect(frames).toContain('event: sync:progress')
    await events.close()
  })
  it('数据库监听断开时结束 SSE，重连可重新 LISTEN', async () => {
    const { events, client, store, response } = fixture()
    await events.ready(); const res = response(); events.attach(res as unknown as ServerResponse)
    client.emit('error', new Error('监听断开'))
    expect(res.end).toHaveBeenCalledOnce(); expect(client.release).toHaveBeenCalledWith(true)
    await events.ready(); expect(store.pool.connect).toHaveBeenCalledTimes(2)
    await events.close()
  })
  it('慢客户端背压时销毁连接，不影响其他客户端推送', async () => {
    const { events, response } = fixture(), slow = response(), normal = response()
    events.attach(slow as unknown as ServerResponse); events.attach(normal as unknown as ServerResponse)
    slow.write.mockReturnValue(false)
    events.publish('workbench:changed', { dataVersion: 'new' })
    expect(slow.destroy).toHaveBeenCalledOnce()
    expect(normal.write).toHaveBeenLastCalledWith('event: workbench:changed\ndata: {"dataVersion":"new"}\n\n')
    await events.close()
  })
})
