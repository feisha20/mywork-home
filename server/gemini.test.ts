import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listGeminiRecordFiles, readGeminiDelta, type GeminiRecordFile } from './gemini.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const cutoff = '2026-09-25T00:00:00Z', time = '2026-10-02T01:30:00Z'
const metadata = { sessionId: 'gemini-session', projectHash: 'project-hash', startTime: time, lastUpdated: time }
const user = { id: 'u1', type: 'user', timestamp: time, content: [{ text: '修复登录接口' }] }
const assistant = { id: 'a1', type: 'gemini', timestamp: time, content: [{ text: '登录接口已完成修复' }] }
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
async function fixture(content: string, extension = 'jsonl'): Promise<GeminiRecordFile> {
  const root = await mkdtemp(join(tmpdir(), 'workbench-gemini-')); directories.push(root)
  const project = join(root, 'project'), chats = join(project, 'chats')
  await mkdir(chats, { recursive: true }); await writeFile(join(project, '.project_root'), '/Users/测试/项目\n')
  const path = join(chats, `session-test.${extension}`); await writeFile(path, content)
  return (await listGeminiRecordFiles(root)).find((file) => file.path === path)!
}

describe('Gemini CLI 会话采集', () => {
  it('限定 chats 范围，保留项目路径并关联嵌套子会话', async () => {
    const file = await fixture(jsonl([metadata, user]))
    const root = directories[0], childDirectory = join(root, 'project/chats', metadata.sessionId)
    await mkdir(childDirectory)
    await writeFile(join(childDirectory, 'child.jsonl'), jsonl([{ ...metadata, sessionId: 'child' }, user]))
    await writeFile(join(root, 'oauth_creds.json'), '不可采集的认证数据')
    await writeFile(join(root, 'project/logs.json'), '不可采集的工具日志')
    const files = await listGeminiRecordFiles(root)
    expect(files).toHaveLength(2)
    const child = files.find((entry) => entry.path.includes('/child.jsonl'))!
    expect(child.parentSessionId).toBe(metadata.sessionId)
    expect((await readGeminiDelta(child, null, cutoff, [])).messages[0]).toMatchObject({ source: 'gemini', sessionId: 'child', rootSessionId: metadata.sessionId, projectPath: file.projectPath })
  })
  it('优先用户显示正文，过滤附件、工具、思考、系统提示及凭证', async () => {
    const file = await fixture(jsonl([
      metadata,
      { ...user, content: [{ text: '注入的文件正文' }, { inlineData: { data: '附件' } }], displayContent: [{ text: '修复登录接口 known-secret-value' }] },
      { ...assistant, thoughts: [{ text: '内部推理' }], toolCalls: [{ result: '工具结果' }], content: [{ text: '内部思考', thought: true }, { functionResponse: { response: '工具输出' } }, { text: '已完成修复' }] },
      { id: 'tool', type: 'gemini', timestamp: time, content: [{ functionCall: { name: 'shell' } }] },
      { ...user, id: 'system', content: [{ text: '<system_instruction>系统上下文</system_instruction>' }] },
      { ...user, id: 'info', type: 'info', content: '运行提示' },
    ]))
    const delta = await readGeminiDelta(file, null, cutoff, ['known-secret-value'])
    expect(delta.messages).toHaveLength(2)
    expect(delta.messages[0].text).toContain('修复登录接口')
    expect(delta.messages[0].text).not.toContain('known-secret-value')
    expect(delta.messages[1]).toMatchObject({ role: 'assistant', text: '已完成修复', timestamp: '2026-10-02T01:30:00.000Z' })
    expect(delta.cursor.context.projectPath).toBe('/Users/测试/项目')
  })
  it('完整历史快照替换旧记录，重复快照和迁移保持相同消息标识', async () => {
    const file = await fixture(jsonl([metadata, { ...user, id: 'removed', content: '已移除' }, { $set: { messages: [user, assistant] } }, { $set: { messages: [user, assistant], lastUpdated: time } }]))
    const first = await readGeminiDelta(file, null, cutoff, [])
    expect(first.messages.map((message) => message.text)).toEqual(['修复登录接口', '登录接口已完成修复'])
    expect((await readGeminiDelta(file, first.cursor, cutoff, [])).messages).toEqual([])
    await appendFile(file.path, jsonl([{ $set: { messages: [user, assistant] } }]))
    expect((await readGeminiDelta(file, first.cursor, cutoff, [])).messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id))
    const legacy = await fixture(JSON.stringify({ ...metadata, messages: [user, assistant] }), 'json')
    expect((await readGeminiDelta(legacy, null, cutoff, [])).messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id))
  })
  it('应用正文补丁、删除与排序，正文更新会采集新版本，工具补丁不重复抽取', async () => {
    const file = await fixture(jsonl([metadata, user, assistant]))
    const first = await readGeminiDelta(file, null, cutoff, [])
    await appendFile(file.path, jsonl([{ $patch: { id: 'a1', toolCalls: [{ id: 'tool', result: '新的工具返回' }] } }]))
    const toolsOnly = await readGeminiDelta(file, first.cursor, cutoff, [])
    expect(toolsOnly.messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id))
    await appendFile(file.path, jsonl([{ $patch: { updates: [{ id: 'a1', content: [{ text: '完成接口修复与验证' }] }], removeIds: ['u1'], orderIds: ['a1'] } }]))
    const patched = await readGeminiDelta(file, toolsOnly.cursor, cutoff, [])
    expect(patched.messages).toHaveLength(1)
    expect(patched.messages[0].text).toBe('完成接口修复与验证')
    expect(patched.messages[0].id).not.toBe(first.messages[1].id)
  })
  it('回退移除目标消息及后文，未知回退目标清空历史', async () => {
    const file = await fixture(jsonl([metadata, user, assistant, { $rewindTo: 'a1' }]))
    const first = await readGeminiDelta(file, null, cutoff, [])
    expect(first.messages.map((message) => message.role)).toEqual(['user'])
    await appendFile(file.path, jsonl([{ $rewindTo: 'unknown' }]))
    expect((await readGeminiDelta(file, first.cursor, cutoff, [])).messages).toEqual([])
  })
  it('末尾中文半行等待追加，损坏行和旧消息不阻断后文', async () => {
    const head = jsonl([metadata, { ...user, timestamp: '2026-09-01T01:00:00Z' }]) + '{损坏}\n'
    const line = Buffer.from(jsonl([assistant])), split = line.indexOf(Buffer.from('登录')) + 1
    const file = await fixture(head)
    await appendFile(file.path, line.subarray(0, split))
    const first = await readGeminiDelta(file, null, cutoff, [])
    expect(first.messages).toEqual([]); expect(first.invalid).toBe(1)
    expect(first.cursor.offset).toBe(Buffer.byteLength(head)); expect(first.blocked).toBe(false)
    await appendFile(file.path, line.subarray(split))
    const second = await readGeminiDelta(file, first.cursor, cutoff, [])
    expect(second.messages[0].text).toBe('登录接口已完成修复')
    expect(second.cursor.offset).toBe((await stat(file.path)).size)
  })
  it('超大行跳过，超大末尾半行标记阻塞，文件替换仍保持消息标识', async () => {
    const file = await fixture(jsonl([metadata]) + jsonl([{ type: 'info', output: 'x'.repeat(5 * 1024 * 1024) }, assistant]))
    const first = await readGeminiDelta(file, null, cutoff, [])
    expect(first.invalid).toBe(1); expect(first.messages).toHaveLength(1)
    await writeFile(file.path, jsonl([metadata, assistant]) + 'x'.repeat(5 * 1024 * 1024))
    const blocked = await readGeminiDelta(file, first.cursor, cutoff, [])
    expect(blocked.blocked).toBe(true)
    expect(blocked.cursor.offset).toBe(Buffer.byteLength(jsonl([metadata, assistant])))
    const moved = `${file.path}.archive.jsonl`; await rename(file.path, moved)
    expect((await readGeminiDelta({ ...file, path: moved }, null, cutoff, [])).messages[0].id).toBe(first.messages[0].id)
  })
  it('无效元信息和未写完的旧版 JSON 不提交游标', async () => {
    await expect(readGeminiDelta(await fixture(jsonl([user])), null, cutoff, [])).rejects.toThrow('元信息')
    await expect(readGeminiDelta(await fixture('{"sessionId":', 'json'), null, cutoff, [])).rejects.toThrow()
  })
  it('仅完整且无坏行的可见快照允许数据库撤回，补丁沿用同一来源标识', async () => {
    const file = await fixture(jsonl([metadata,user,assistant]))
    const first = await readGeminiDelta(file,null,cutoff,[])
    expect(first.reconcile).toBe(true)
    await appendFile(file.path,jsonl([{ $patch: { id:'a1',content:'已修改正文' } }]))
    const changed = await readGeminiDelta(file,first.cursor,cutoff,[])
    expect(changed.messages[1].originKey).toBe(first.messages[1].originKey)
    expect(changed.messages[1].id).not.toBe(first.messages[1].id)
    await appendFile(file.path,'{"id":"unfinished"')
    expect((await readGeminiDelta(file,changed.cursor,cutoff,[])).reconcile).toBe(false)
  })

})
