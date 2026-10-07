import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ZcodeReader } from './zcode.js'

const cutoff = '2026-09-24T00:00:00Z', at = Date.parse('2026-10-01T01:00:00Z')
const directories: string[] = [], databases: DatabaseSync[] = [], readers: ZcodeReader[] = []
const schema = `CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT);
  CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
  CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`
afterEach(async () => {
  readers.splice(0).forEach((reader) => reader.close())
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-zcode-')); directories.push(directory)
  const database = new DatabaseSync(join(directory, 'db.sqlite')); databases.push(database)
  database.exec(`PRAGMA journal_mode=WAL; ${schema}`)
  database.prepare('INSERT INTO session VALUES(?,?,?)').run('session-1', '/Users/测试/工作区', 'parent-1')
  const message = (id: string, data: object, updated = at, created = at) => database.prepare('INSERT INTO message VALUES(?,?,?,?,?)')
    .run(id, 'session-1', created, updated, JSON.stringify(data))
  const part = (id: string, messageId: string, data: object, updated = at) => database.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)')
    .run(id, messageId, 'session-1', updated, updated, JSON.stringify(data))
  const open = () => { const reader = new ZcodeReader(directory); readers.push(reader); return reader }
  return { directory, database, message, part, open }
}

describe('Zcode SQLite 会话采集', () => {
  it('只读读取 WAL 中的会话文字，保留项目、父会话和原始时间并脱敏', async () => {
    const { database, message, part, open } = await fixture()
    message('user-1', { role: 'user', time: { created: at } })
    part('text-1', 'user-1', { type: 'text', text: '<system-reminder>内部上下文</system-reminder>整理工作记录，password=fixture-password-123，fixture-secret' })
    part('text-2', 'user-1', { type: 'text', text: '追加说明', time: { end: at } }, at + 1)
    message('assistant-1', { role: 'assistant', time: { completed: at + 200 }, finish: 'tool-calls' }, at + 200, at + 100)
    part('answer-1', 'assistant-1', { type: 'text', text: '已完成工作记录整理' }, at + 200)
    part('reasoning-1', 'assistant-1', { type: 'reasoning', text: '内部思考' })
    part('tool-1', 'assistant-1', { type: 'tool', state: { output: '工具返回内容' } })
    part('file-1', 'user-1', { type: 'file', url: '附件内容' })
    const reader = open(), session = reader.sessions(cutoff)[0]
    const delta = reader.readDelta(session, null, cutoff, ['fixture-secret'])
    expect(delta.messages).toHaveLength(2)
    expect(delta.messages[0]).toMatchObject({ source: 'zcode', sessionId: 'session-1', rootSessionId: 'parent-1', projectPath: '/Users/测试/工作区', role: 'user', timestamp: new Date(at).toISOString() })
    expect(delta.messages[0].text).toContain('追加说明')
    expect(delta.messages[0].text).not.toMatch(/内部上下文|fixture-password-123|fixture-secret|附件内容/)
    expect(delta.messages[1].text).toBe('已完成工作记录整理')
    expect(delta.messages[1].timestamp).toBe(new Date(at + 100).toISOString())
    expect(delta.cursor.context.parentSessionId).toBe('parent-1')
    expect(database.prepare('SELECT count(*) AS count FROM message').get()?.count).toBe(2)
  })

  it('忽略隐藏提醒、压缩摘要、合成片段与未结束回复，旧消息不进入回溯范围', async () => {
    const { message, part, open } = await fixture()
    const ignored = [
      { role: 'user', synthetic: true },
      { role: 'user', semantics: { uiVisibility: 'hidden' } },
      { role: 'user', semantics: { transcriptVisibility: 'hidden' } },
      { role: 'user', metadata: { visibility: 'model-only' } },
      { role: 'assistant', summary: true, time: { completed: at } },
      { role: 'assistant', time: { created: at } },
      { role: 'tool' },
    ]
    ignored.forEach((data, index) => {
      message(`ignored-${index}`, data)
      part(`ignored-part-${index}`, `ignored-${index}`, { type: 'text', text: '不应采集' })
    })
    message('old', { role: 'user' }, at, Date.parse('2026-09-01T00:00:00Z'))
    part('old-part', 'old', { type: 'text', text: '旧消息' })
    message('real', { role: 'user' })
    part('real-text', 'real', { type: 'text', text: '真实要求' })
    part('synthetic', 'real', { type: 'text', text: '系统提示', synthetic: true })
    part('ignored', 'real', { type: 'text', text: '忽略片段', ignored: true })
    const reader = open()
    expect(reader.readDelta(reader.sessions(cutoff)[0], null, cutoff, []).messages.map((entry) => entry.text)).toEqual(['真实要求'])
  })

  it('增量检测消息和片段更新，流式结束后采集完整回复并保留稳定标识', async () => {
    const { database, message, part, open } = await fixture()
    message('user', { role: 'user' }); part('request', 'user', { type: 'text', text: '整理工作日志' })
    message('stream', { role: 'assistant', time: { created: at + 10 } }, at + 10, at + 10)
    part('reply', 'stream', { type: 'text', text: '正在整理' }, at + 10)
    const reader = open(), session = reader.sessions(cutoff)[0]
    const first = reader.readDelta(session, null, cutoff, [])
    expect(first.messages.map((entry) => entry.role)).toEqual(['user'])
    database.prepare('UPDATE part SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({ type: 'text', text: '已完成工作日志整理' }), at + 20, 'reply')
    const streaming = reader.readDelta(session, first.cursor, cutoff, [])
    expect(streaming.messages).toEqual([])
    database.prepare('UPDATE message SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({ role: 'assistant', time: { completed: at + 30 } }), at + 30, 'stream')
    const completed = reader.readDelta(session, streaming.cursor, cutoff, [])
    expect(completed.messages.map((entry) => entry.text)).toEqual(['已完成工作日志整理'])
    // 同一毫秒的新记录也读取；边界重读交给数据库按消息标识去重。
    message('same-time', { role: 'user' }, at + 30, at + 30)
    part('same-time-text', 'same-time', { type: 'text', text: '补充同刻记录' }, at + 30)
    const next = reader.readDelta(session, completed.cursor, cutoff, [])
    expect(next.messages).toContainEqual(completed.messages[0])
    expect(next.messages.map((entry) => entry.text)).toContain('补充同刻记录')
    database.prepare('UPDATE part SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({ type: 'text', text: '片段更新后的要求' }), at + 40, 'same-time-text')
    expect(reader.readDelta(session, next.cursor, cutoff, []).messages.map((entry) => entry.text)).toEqual(['已完成工作日志整理', '片段更新后的要求'])
  })

  it('会话文件移动后标识不变，数据库替换后重置游标且损坏消息不阻断后续读取', async () => {
    const { directory, database, message, part, open } = await fixture()
    message('user', { role: 'user' }); part('request', 'user', { type: 'text', text: '有效要求' })
    message('broken', { role: 'user' }); database.prepare('UPDATE message SET data=? WHERE id=?').run('{损坏}', 'broken')
    const reader = open(), session = reader.sessions(cutoff)[0], first = reader.readDelta(session, null, cutoff, [])
    expect(first.invalid).toBe(1); expect(first.messages).toHaveLength(1)
    reader.close(); readers.pop(); database.close(); databases.pop()
    const moved = `${directory}-moved`; await rename(directory, moved); directories.push(moved)
    const reopened = new ZcodeReader(moved); readers.push(reopened)
    expect(reopened.readDelta(session, null, cutoff, []).messages[0].id).toBe(first.messages[0].id)
    const reset = reopened.readDelta(session, { ...first.cursor, inode: '替换前的文件', offset: at + 1000 }, cutoff, [])
    expect(reset.messages[0].id).toBe(first.messages[0].id)
  })

  it('数据库缺失时报告读取失败，不自动创建空数据库', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-zcode-missing-')); directories.push(directory)
    expect(() => new ZcodeReader(directory)).toThrow()
  })
})
