import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EMPTY_RECORD_MAPPING, recordMappingSchema } from '../shared/settings.js'
import { classifyCompatibleFile, detectRecordFormat, fieldValue, isCompatibleDatabase, listCompatibleCandidates, normalizeGenericRecords, previewCompatibleRecords, readCompatibleDelta } from './compatibleRecords.js'
import type { RecordContext } from './records.js'

let directory: string
const at = '2026-10-01T01:00:00.000Z', cutoff = '2026-09-24T00:00:00.000Z'
const context = (): RecordContext => ({ sessionId: 'fallback', projectPath: '', parentSessionId: null, turnId: '' })
const message = (text = '整理兼容格式', id = 'm-1') => ({ id, sessionId: 'session-1', speaker: 'human', body: { text }, time: Date.parse(at) / 1000 })
const line = (row: unknown) => JSON.stringify(row) + '\n'
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'workbench-compatible-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
async function file(name: string, content: string) { const path = join(directory, name); await writeFile(path, content); return path }

describe('通用会话字段兼容', () => {
  it('自动识别 JSONL、JSON 快照和其他品牌的通用字段', () => {
    const samples = {
      codex: { type: 'session_meta', payload: { id: 'session-1', cwd: '/project' } },
      claude: { type: 'user', sessionId: 'session-1', uuid: 'm-1', timestamp: at, message: { content: '任务' } },
      workbuddy: { type: 'message', role: 'assistant', sessionId: 'session-1', timestamp: Date.parse(at), content: '完成' },
      gemini: { sessionId: 'session-1', messages: [{ type: 'gemini', id: 'm-1', timestamp: at, content: '完成' }] },
      generic: message(),
    } as const
    for (const [format, row] of Object.entries(samples)) expect(detectRecordFormat([row])).toBe(format)
    expect(detectRecordFormat([Object.values(samples).slice(0, 1)])).toBe('codex')
    expect(detectRecordFormat([{ token: '凭证', configured: true }])).toBeNull()
  })
  it('支持导出列表、嵌套字段和秒/毫秒时间戳，继承会话项目元信息', () => {
    const mapping = { ...EMPTY_RECORD_MAPPING, messages: 'data.entries', role: 'person.kind', text: 'body.markdown', timestamp: 'clock.at', sessionId: 'dialogId', messageId: 'key', projectPath: 'location' }
    const rows = { dialogId: 'exported-session', location: '/project', data: { entries: [
      { key: 'one', person: { kind: 'human' }, body: { markdown: '测试一' }, clock: { at: Date.parse(at) / 1000 } },
      { key: 'two', person: { kind: 'model' }, body: { markdown: '测试二' }, clock: { at: String(Date.parse(at)) } },
    ] } }
    expect(detectRecordFormat([rows], mapping)).toBe('generic')
    const normalized = normalizeGenericRecords(rows, context(), 'custom-other', mapping)
    expect(normalized.invalid).toBe(0)
    expect(normalized.messages.map(({ text, role, timestamp, sessionId, projectPath, source }) => ({ text, role, timestamp, sessionId, projectPath, source }))).toEqual([
      { text: '测试一', role: 'user', timestamp: at, sessionId: 'exported-session', projectPath: '/project', source: 'custom-other' },
      { text: '测试二', role: 'assistant', timestamp: at, sessionId: 'exported-session', projectPath: '/project', source: 'custom-other' },
    ])
  })
  it('文件内多会话独立分组，父会话不泄漏到后续会话', () => {
    const ctx = context()
    const result = normalizeGenericRecords({ conversations: [
      { id: 'child', parentSessionId: 'root', projectPath: '/one', summary: '会话简介', messages: [{ role: 'user', content: '子会话', timestamp: at }] },
      { id: 'separate', projectPath: '/two', messages: [{ role: 'assistant', content: '独立会话', timestamp: at }] },
    ] }, ctx, 'custom-other')
    expect(result.messages.map(({ sessionId, rootSessionId, projectPath }) => ({ sessionId, rootSessionId, projectPath }))).toEqual([
      { sessionId: 'child', rootSessionId: 'root', projectPath: '/one' }, { sessionId: 'separate', rootSessionId: 'separate', projectPath: '/two' },
    ])
    expect(ctx.sessionId).toBe('separate')
    const sequential = normalizeGenericRecords([{ sessionId: 'metadata-session', cwd: '/metadata' }, { role: 'user', text: '继承元信息', timestamp: at }], context(), 'custom-other')
    expect(sequential.messages[0]).toMatchObject({ sessionId: 'metadata-session', projectPath: '/metadata' })
  })
  it('读取常见导出字典中的消息，跳过工具、推理和系统注入，时间缺失明确计数', () => {
    const result = normalizeGenericRecords({ id: 'export', mapping: {
      a: { parent: 'previous-message', message: { id: 'a', author: { role: 'user' }, content: { parts: ['导出的用户消息'] }, create_time: Date.parse(at) / 1000 } },
      b: { message: { author: { role: 'assistant' }, channel: 'analysis', content: { parts: ['内部推理'] }, create_time: Date.parse(at) } },
      c: { role: 'assistant', type: 'tool_result', text: '工具', timestamp: at },
      d: { role: 'user', text: '# AGENTS.md instructions\n不采集', timestamp: at },
      e: { role: 'assistant', text: '缺少时间' },
      f: { role: 'assistant', text: '错误时间', timestamp: 'invalid' },
    } }, context(), 'custom-other')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ text: '导出的用户消息', rootSessionId: 'export' })
    expect(result.invalid).toBe(2)
  })
  it('字段读取只支持自身属性和安全路径，预览正文隐藏凭证', () => {
    expect(fieldValue(Object.create({ inherited: '不读取' }), 'inherited')).toBeUndefined()
    for (const path of ['__proto__.polluted', 'constructor.name', 'content[0]', 'process.exit()']) {
      expect(recordMappingSchema.safeParse({ ...EMPTY_RECORD_MAPPING, text: path }).success).toBe(false)
    }
    const normalized = normalizeGenericRecords(message('配置测试密钥 known-test-secret-value'), context(), 'custom-other', EMPTY_RECORD_MAPPING, ['known-test-secret-value'])
    expect(normalized.messages[0].text).not.toContain('known-test-secret-value')
  })
})

describe('兼容采集与读取预览', () => {
  it('不提交半行，追加完成、截短和移动后保持去重标识', async () => {
    const one = line(message('中文事项一')), two = line(message('中文事项二', 'm-2'))
    const path = await file('conversation.jsonl', one + two.slice(0, 40))
    const reader = (await classifyCompatibleFile(path, 'auto'))!
    const first = await readCompatibleDelta(reader, 'custom-other', null, cutoff, [])
    expect(first.messages.map((row) => row.text)).toEqual(['中文事项一'])
    expect(first.cursor.offset).toBe(Buffer.byteLength(one))
    await appendFile(path, two.slice(40))
    const next = await readCompatibleDelta(reader, 'custom-other', first.cursor, cutoff, [])
    expect(next.messages.map((row) => row.text)).toEqual(['中文事项二'])
    await writeFile(path, one)
    const reset = await readCompatibleDelta(reader, 'custom-other', next.cursor, cutoff, [])
    expect(reset.messages[0].id).toBe(first.messages[0].id)
    const moved = join(directory, 'moved.jsonl'); await rename(path, moved)
    const movedReader = (await classifyCompatibleFile(moved, 'auto'))!
    expect((await readCompatibleDelta(movedReader, 'custom-other', null, cutoff, [])).messages[0].id).toBe(first.messages[0].id)
  })
  it('字段配置变化重新读取未改动的文件，快照正文变化产生新版本，旧消息按窗口过滤', async () => {
    const path = await file('snapshot.json', JSON.stringify({ sessionId: 'snapshot', messages: [
      { id: 'a', role: 'user', content: '原字段', alternate: '新字段', timestamp: at },
      { id: 'old', role: 'user', content: '旧消息', alternate: '旧消息', timestamp: '2026-09-01T00:00:00Z' },
    ] }))
    const firstReader = (await classifyCompatibleFile(path, 'generic'))!
    const first = await readCompatibleDelta(firstReader, 'custom-other', null, cutoff, [])
    expect(first.messages.map((row) => row.text)).toEqual(['原字段'])
    const mapping = { ...EMPTY_RECORD_MAPPING, text: 'alternate' }, changedReader = (await classifyCompatibleFile(path, 'generic', mapping))!
    expect(changedReader.signature).not.toBe(firstReader.signature)
    const changed = await readCompatibleDelta(changedReader, 'custom-other', first.cursor, cutoff, [], mapping)
    expect(changed.messages.map((row) => row.text)).toEqual(['新字段'])
    expect(changed.messages[0].id).not.toBe(first.messages[0].id)
    await writeFile(path, JSON.stringify({ sessionId: 'snapshot', messages: [{ id: 'a', role: 'user', content: '修改后的正文', timestamp: at }] }))
    const updated = await readCompatibleDelta(firstReader, 'custom-other', first.cursor, cutoff, [])
    expect(updated.messages[0].text).toBe('修改后的正文'); expect(updated.messages[0].id).not.toBe(first.messages[0].id)
  })
  it('保留 JSONL 元信息，并用各工具读取器解析混合来源目录', async () => {
    await file('codex.jsonl', line({ type: 'session_meta', payload: { id: 'codex-session', cwd: '/project' } }) + line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 记录' }] } }))
    await file('claude.jsonl', line({ type: 'user', sessionId: 'claude-session', uuid: 'm-1', timestamp: at, message: { content: 'Claude 记录' } }))
    await file('workbuddy.jsonl', line({ type: 'message', sessionId: 'wb-session', role: 'assistant', id: 'm-1', timestamp: Date.parse(at), content: 'WorkBuddy 记录' }))
    await file('gemini.json', JSON.stringify({ sessionId: 'gemini-session', messages: [{ type: 'user', id: 'm-1', timestamp: at, content: 'Gemini 记录' }] }))
    const preview = await previewCompatibleRecords([directory], 'auto', undefined, [])
    expect(preview.checkedFiles).toBe(4); expect(preview.compatibleFiles).toBe(4)
    expect(preview.formats.sort()).toEqual(['Codex 会话', 'Claude Code 会话', 'WorkBuddy 会话', 'Gemini CLI 会话'].sort())
    expect(preview.messages).toHaveLength(3)
    const meta = await file('other.jsonl', line({ sessionId: 'metadata', cwd: '/metadata' }) + line({ role: 'user', timestamp: at, content: '通用元信息' }))
    const delta = await readCompatibleDelta((await classifyCompatibleFile(meta, 'auto'))!, 'custom-other', null, cutoff, [])
    expect(delta.messages[0]).toMatchObject({ sessionId: 'metadata', projectPath: '/metadata' })
  })
  it('仅遍历会话候选文件，不跟随软链接，不读取凭证/配置文件', async () => {
    await file('records.jsonl', line(message()))
    for (const name of ['auth.json', 'credentials.json', 'settings.json', 'package.json', 'config.json']) await file(name, line(message()))
    await mkdir(join(directory, 'cache')); await writeFile(join(directory, 'cache/session.json'), JSON.stringify(message()))
    await symlink(join(directory, 'records.jsonl'), join(directory, 'link.jsonl'))
    expect(await listCompatibleCandidates(directory)).toEqual([join(directory, 'records.jsonl')])
  })
  it('预览限制文件数量，报告缺少时间和未知格式，不把可读取等同可解析', async () => {
    await file('00-unknown.json', '{"unknown":true}')
    await file('01-invalid.jsonl', line({ role: 'user', text: '缺少时间' }))
    for (let index = 2; index < 12; index++) await file(`${String(index).padStart(2, '0')}-sample.jsonl`, line(message('预览正文 known-test-secret-value', `m-${index}`)))
    const preview = await previewCompatibleRecords([directory], 'auto', undefined, ['known-test-secret-value'])
    expect(preview.checkedFiles).toBe(8); expect(preview.compatibleFiles).toBe(6)
    expect(preview.issues.join(' ')).toMatch(/未识别/); expect(preview.issues.join(' ')).toMatch(/有效时间/); expect(preview.issues.join(' ')).toMatch(/前 8/)
    expect(JSON.stringify(preview)).not.toContain('known-test-secret-value')
    expect(preview.messages).toHaveLength(3)
  })
  it('过大快照拒绝解析，只识别已支持的数据库表结构', async () => {
    const large = await file('large.json', ' '.repeat(8 * 1024 * 1024 + 1))
    await expect(classifyCompatibleFile(large, 'auto')).rejects.toThrow('超过 8 MB')
    const database = new DatabaseSync(join(directory, 'db.sqlite'))
    database.exec('CREATE TABLE unknown(id TEXT,body TEXT);')
    expect(isCompatibleDatabase(directory)).toBe(false)
    database.exec(`CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT);
      CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE part(id TEXT,message_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`)
    database.close()
    expect(isCompatibleDatabase(directory)).toBe(true)
    expect(await previewCompatibleRecords([directory], 'auto', undefined, [])).toMatchObject({ formats: ['Zcode 数据库'], checkedFiles: 1, compatibleFiles: 1 })
  })
})
