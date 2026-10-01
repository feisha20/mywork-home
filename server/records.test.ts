import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialContext, normalizeRecord, readDelta } from './records.js'
import { redact } from './redact.js'
import { messageBatches } from './sync.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const time = '2026-10-01T01:00:00Z', cutoff = '2026-09-24T00:00:00Z'
function claude(text: string, id = 'message-1') { return { type: 'user', uuid: id, sessionId: 'session-1', cwd: '/Users/测试/项目', timestamp: time, message: { content: text } } }
async function file(content: string) { const dir = await mkdtemp(join(tmpdir(), 'workbench-records-')); directories.push(dir); const path = join(dir, 'session-1.jsonl'); await writeFile(path, content); return path }

describe('会话记录适配与脱敏', () => {
  it('从Codex元信息保留原项目路径并关联父会话', () => {
    const ctx = initialContext('rollout-test.jsonl', 'codex')
    normalizeRecord({ type: 'session_meta', payload: { id: 'child', cwd: '/Users/项目', source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } } } }, 'codex', ctx)
    normalizeRecord({ type: 'turn_context', payload: { turn_id: 'turn-1' } }, 'codex', ctx)
    const row = { timestamp: time, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成接口测试' }] } }
    const first = normalizeRecord(row, 'codex', ctx)!
    const duplicate = normalizeRecord({ timestamp: time, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已完成接口测试' } }, 'codex', ctx)!
    expect(first.rootSessionId).toBe('root'); expect(first.projectPath).toBe('/Users/项目'); expect(duplicate.id).toBe(first.id)
    expect(normalizeRecord({ ...row, payload: { type: 'function_call', name: 'bash' } }, 'codex', ctx)).toBeNull()
    expect(normalizeRecord({ ...row, payload: { ...row.payload, channel: 'analysis' } }, 'codex', ctx)).toBeNull()
  })
  it('Claude只提取文字，忽略工具结果、推理和压缩摘要', () => {
    const ctx = initialContext('/project/session-1/subagents/agent-1.jsonl', 'claude')
    const row = { ...claude(''), message: { content: [{ type: 'tool_result', content: '工具输出' }, { type: 'thinking', thinking: '内部思考' }, { type: 'text', text: '修复登录接口' }] } }
    expect(normalizeRecord(row, 'claude', ctx)?.text).toBe('修复登录接口')
    expect(ctx.parentSessionId).toBe('session-1')
    expect(normalizeRecord({ ...row, isMeta: true }, 'claude', ctx)).toBeNull()
    expect(normalizeRecord({ ...row, isCompactSummary: true }, 'claude', ctx)).toBeNull()
  })
  it('不提交末尾半行，追加完成后只读取新增记录且保留中文', async () => {
    const one = JSON.stringify(claude('中文事项一')), two = JSON.stringify(claude('中文事项二', 'message-2'))
    const path = await file(`${one}\n${two.slice(0, 40)}`)
    const first = await readDelta(path, 'claude', null, cutoff, [])
    expect(first.messages).toHaveLength(1); expect(first.cursor.offset).toBe(Buffer.byteLength(`${one}\n`))
    await appendFile(path, `${two.slice(40)}\n`)
    const second = await readDelta(path, 'claude', first.cursor, cutoff, [])
    expect(second.messages.map((message) => message.text)).toEqual(['中文事项二'])
  })
  it('文件截短或移动后重读仍保持相同事件ID', async () => {
    const content = JSON.stringify(claude('已有事项')) + '\n'
    const path = await file(content + JSON.stringify(claude('第二项', '2')) + '\n')
    const first = await readDelta(path, 'claude', null, cutoff, [])
    await writeFile(path, content)
    const reset = await readDelta(path, 'claude', first.cursor, cutoff, [])
    expect(reset.messages[0].id).toBe(first.messages[0].id)
    const moved = `${path}.archive.jsonl`; await rename(path, moved)
    expect((await readDelta(moved, 'claude', null, cutoff, [])).messages[0].id).toBe(first.messages[0].id)
  })
  it('损坏行和回溯窗口之外的消息不阻断后续记录', async () => {
    const old = { ...claude('旧事项'), timestamp: '2026-09-01T00:00:00Z' }
    const path = await file(`{损坏}\n${JSON.stringify(old)}\n${JSON.stringify(claude('最近事项'))}\n`)
    const delta = await readDelta(path, 'claude', null, cutoff, [])
    expect(delta.invalid).toBe(1); expect(delta.messages.map((entry) => entry.text)).toEqual(['最近事项'])
  })
  it('跨块超大工具日志不会错位或无限重读', async () => {
    const path = await file(`${JSON.stringify({ type: 'progress', data: 'x'.repeat(5 * 1024 * 1024) })}\n${JSON.stringify(claude('有效消息'))}\n`)
    const first = await readDelta(path, 'claude', null, cutoff, [])
    const second = await readDelta(path, 'claude', first.cursor, cutoff, [])
    expect([...first.messages, ...second.messages].map((entry) => entry.text)).toEqual(['有效消息'])
    expect(first.invalid).toBe(1)
  })
  it('隐藏已知凭证、表格密码、API密钥及连接口令', () => {
    const input = '│ 密码 │ abcdef1234567890 │\nAPI_KEY="sk-abcdefghijklmnopqrstuv"\nAuthorization: Bearer token012345678\npostgresql://user:dbpassword@localhost/db\n秘密 known-secret-value'
    const safe = redact(input, ['known-secret-value'])
    for (const secret of ['abcdef1234567890', 'sk-abcdefghijklmnopqrstuv', 'token012345678', 'dbpassword', 'known-secret-value']) expect(safe).not.toContain(secret)
  })
  it('中文全角冒号、Markdown代码和加粗格式下仍隐藏口令', () => {
    for (const input of ['密码：`abcdef1234567890`', '**密码**：**abcdef1234567890**', '`password`: `abcdef1234567890`', '连接：postgresql://postgres:abcdef1234567890@localhost/db']) {
      expect(redact(input)).not.toContain('abcdef1234567890')
    }
  })
  it('隐藏代码数组中的短十六进制凭证，同时保留来源摘要ID', () => {
    const credential = '0123456789abcdef01234567'
    const messageId = 'a'.repeat(64)
    const safe = redact(`secrets=['${credential}']; id=${messageId}`)
    expect(safe).not.toContain(credential)
    expect(safe).toContain(messageId)
  })
  it('分批限制文字长度，并保留来源标识', () => {
    const message = normalizeRecord(claude('事项'), 'claude', initialContext('x.jsonl', 'claude'))!
    const batches = messageBatches([{ ...message, text: 'x'.repeat(40000) }, { ...message, id: 'next', text: '后续' }])
    expect(batches).toHaveLength(2); expect(batches[0][0].id).toBe(message.id); expect(batches[0][0].text.length).toBeLessThan(31000)
  })
})
