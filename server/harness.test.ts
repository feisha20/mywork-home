import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { extractionFailureReason, extractionInput, harnessPatch, parseExtraction, parseSummaries, summaryGuidance } from './harness.js'
import type { SourceMessage } from './records.js'

const message: SourceMessage = { id: 'evidence-1', source: 'codex', sessionId: 'test', rootSessionId: 'test', projectPath: '/project', role: 'assistant', timestamp: '2026-10-01T01:00:00Z', text: '已修复接口并通过测试' }
describe('模型输出边界', () => {
  it('保留个人事项，分类必须明确为布尔值，缺失或字符串分类触发重新抽取', () => {
    const item = { title: '安排家庭假期出行', status: 'todo', isPersonal: false, evidenceIds: [message.id], isPersonal: true }
    expect(parseExtraction(JSON.stringify({ items: [item] }), [message], [], [])[0].isPersonal).toBe(true)
    expect(() => parseExtraction(JSON.stringify({ items: [{ title: item.title, status: item.status, evidenceIds: item.evidenceIds }] }), [message], [], [])).toThrow()
    for (const isPersonal of ['true', 'false', 1, null]) {
      expect(() => parseExtraction(JSON.stringify({ items: [{ ...item, isPersonal }] }), [message], [], [])).toThrow()
    }
    const persona = JSON.stringify(harnessPatch(loadConfig({ DATABASE_URL: 'postgresql://app:fixture@localhost/test' })))
    expect(persona).toContain('个人事项也要保留')
    expect(persona).toContain('工作与私人事项必须分开抽取')
    expect(persona).toContain('无法确定时为 false')
  })
  it('人工分类传给模型并在解析时保留，独立于完成状态', () => {
    for (const isPersonal of [true, false]) {
      const task = { id: 'corrected', source: 'codex' as const, reference: 'CX-1', title: '整理事项', createdAt: message.timestamp,
        completedAt: null, isPersonal, personalOrigin: 'manual' as const, statusOrigin: 'ai' as const }
      const input = extractionInput([message], [], [task])
      expect(JSON.parse(input.prompt).existingTasks[0]).toMatchObject({ isPersonal, personalManualOverride: true, manualOverride: false })
      const items = [{ taskId: 'T1', title: '完成事项整理', status: 'completed', isPersonal: !isPersonal, evidenceIds: ['M1'] }]
      expect(parseExtraction(JSON.stringify({ items }), [message], [], [task], input.references)[0]).toMatchObject({ isPersonal, status: 'completed' })
    }
  })
  it('短别名还原真实证据与事项ID，不把旧事项证据混入可引用消息', () => {
    const previous = { ...message, id: 'previous-evidence', timestamp: '2026-09-30T01:00:00Z' }
    const task = { id: 'real-task', source: 'codex' as const, reference: 'CX-1', title: '修复接口', createdAt: previous.timestamp,
      evidence: [{ messageId: 'unavailable-evidence', source: 'codex' as const, sessionId: 'test', projectPath: '/project', timestamp: previous.timestamp, quote: '旧证据' }] }
    const input = extractionInput([message], [previous], [task])
    expect(input.prompt).not.toContain('unavailable-evidence')
    expect(JSON.parse(input.prompt).newMessages[0].id).toBe('M1')
    expect(JSON.parse(input.prompt).existingTasks[0].taskId).toBe('T1')
    const output = { items: [{ taskId: 'T1', title: '修复接口', status: 'completed', isPersonal: false, evidenceIds: ['M1', 'C1'] }] }
    expect(parseExtraction(JSON.stringify(output), [message], [previous], [task], input.references)[0]).toEqual({
      taskId: task.id, title: '修复接口', status: 'completed', isPersonal: false, evidenceIds: [message.id, previous.id],
    })
    output.items[0].evidenceIds = ['C1']
    expect(() => parseExtraction(JSON.stringify(output), [message], [previous], [task], input.references)).toThrow('本批新增消息')
    output.items[0].evidenceIds = ['M99']
    expect(() => parseExtraction(JSON.stringify(output), [message], [previous], [task], input.references)).toThrow('未知来源证据')
    output.items[0].evidenceIds = ['M1']; output.items[0].taskId = 'T99'
    expect(() => parseExtraction(JSON.stringify(output), [message], [previous], [task], input.references)).toThrow('未知事项 ID')
  })
  it('校验错误保留可定位的类型，隐藏任意模型输出', () => {
    expect(extractionFailureReason(Object.assign(new Error('校验失败'), { validationFeedback: '输出包含未知来源证据' }))).toContain('未知来源证据')
    expect(extractionFailureReason(Object.assign(new Error('校验失败'), { validationFeedback: 'items.0.title: Too big' }))).toContain('1至60字')
    expect(extractionFailureReason(Object.assign(new Error('校验失败'), { validationFeedback: '秘密正文和未知ID' }))).not.toContain('秘密正文')
    expect(extractionFailureReason(new Error('模型请求超时'))).toBeUndefined()
  })
  it('校验JSON、标题与真实证据，不信任模型任意ID', () => {
    expect(parseExtraction('```json\n{"items":[{"title":"修复接口","status":"completed","isPersonal":false,"evidenceIds":["evidence-1"]}]}\n```', [message], [], [])).toHaveLength(1)
    expect(() => parseExtraction('{"items":[{"title":"修复","status":"completed","isPersonal":false,"evidenceIds":["fake"]}]}', [message], [], [])).toThrow()
    expect(() => parseExtraction('{"items":[{"taskId":"fake","title":"修复","status":"todo","isPersonal":false,"evidenceIds":["evidence-1"]}]}', [message], [], [])).toThrow()
    expect(() => parseExtraction('{"items":[{"title":"修复","status":"done","isPersonal":false,"evidenceIds":["evidence-1"]}]}', [message], [], [])).toThrow()
    expect(() => parseExtraction('{"items":[{"title":"修复","status":"todo","isPersonal":false,"evidenceIds":["evidence-1"]}]}', [], [message], [])).toThrow()
  })
  it('输出重复事项只应用一次', () => {
    const item = { title: '修复接口', status: 'completed', isPersonal: false, evidenceIds: ['evidence-1'] }
    expect(parseExtraction(JSON.stringify({ items: [item, item] }), [message], [], [])).toHaveLength(1)
  })
  it('模型不能自动完成或修改手工待办与禅道任务', () => {
    for (const source of ['manual', 'zentao'] as const) {
      const task = { id: 'protected', reference: 'TASK-1', source, title: '修复接口', createdAt: message.timestamp, completedAt: null }
      const raw = JSON.stringify({ items: [{ taskId: task.id, title: '修复接口', status: 'completed', isPersonal: false, evidenceIds: [message.id] }] })
      expect(() => parseExtraction(raw, [message], [], [task])).toThrow('未知事项 ID')
    }
  })
  it('新事项的空ID按未提供处理，生成稳定ID由数据库负责', () => {
    const raw = JSON.stringify({ items: [{ taskId: '', title: '修复接口', status: 'todo', isPersonal: false, evidenceIds: ['evidence-1'] }] })
    expect(parseExtraction(raw, [message], [], [])[0].taskId).toBeUndefined()
  })
  it('简介超长时重新生成，不截断原文作为标题', () => {
    expect(() => parseExtraction(JSON.stringify({ items: [{ title: '长'.repeat(61), status: 'todo', isPersonal: false, evidenceIds: ['evidence-1'] }] }), [message], [], [])).toThrow()
    expect(summaryGuidance).toContain('不照抄原始需求')
  })
  it('旧事项简介必须逐项对应，禁止新增、遗漏或重复ID', () => {
    const tasks = [{ id: 'task-1' }, { id: 'task-2' }] as Parameters<typeof parseSummaries>[1]
    const item = { taskId: 'task-1', title: '完善测试操作指引，覆盖用例创建与维护' }
    expect(() => parseSummaries(JSON.stringify({ items: [item] }), tasks)).toThrow()
    expect(() => parseSummaries(JSON.stringify({ items: [item, item] }), tasks)).toThrow()
    expect(() => parseSummaries(JSON.stringify({ items: [item, { ...item, taskId: 'unknown' }] }), tasks)).toThrow()
    expect(parseSummaries(JSON.stringify({ items: [item, { ...item, taskId: 'task-2' }] }), tasks)).toHaveLength(2)
  })
  it('专用配置关闭执行工具和上传，密钥仅通过环境变量读取', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://workbench:test@localhost/test', WORKBENCH_LLM_API_KEY: 'private-value' })
    const patch = harnessPatch(config)
    const serialized = JSON.stringify(patch)
    expect(serialized).not.toContain('private-value')
    for (const id of ['persistent-bash', 'terminal-bash', 'pty', 'session-log-deepseek', 'plugin-package-inventory-deepseek']) expect(patch).toContainEqual({ id, disabled: true })
    expect(serialized).toContain('openai-completions'); expect(serialized).toContain('glm-5.3-flash')
  })
})
