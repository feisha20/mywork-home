import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { harnessPatch, parseExtraction, parseSummaries, summaryGuidance } from './harness.js'
import type { SourceMessage } from './records.js'

const message: SourceMessage = { id: 'evidence-1', source: 'codex', sessionId: 'test', rootSessionId: 'test', projectPath: '/project', role: 'assistant', timestamp: '2026-10-01T01:00:00Z', text: '已修复接口并通过测试' }
describe('模型输出边界', () => {
  it('校验JSON、标题与真实证据，不信任模型任意ID', () => {
    expect(parseExtraction('```json\n{"items":[{"title":"修复接口","status":"completed","evidenceIds":["evidence-1"]}]}\n```', [message], [], [])).toHaveLength(1)
    expect(() => parseExtraction('{"items":[{"title":"修复","status":"completed","evidenceIds":["fake"]}]}', [message], [], [])).toThrow()
    expect(() => parseExtraction('{"items":[{"taskId":"fake","title":"修复","status":"todo","evidenceIds":["evidence-1"]}]}', [message], [], [])).toThrow()
    expect(() => parseExtraction('{"items":[{"title":"修复","status":"done","evidenceIds":["evidence-1"]}]}', [message], [], [])).toThrow()
    expect(() => parseExtraction('{"items":[{"title":"修复","status":"todo","evidenceIds":["evidence-1"]}]}', [], [message], [])).toThrow()
  })
  it('输出重复事项只应用一次', () => {
    const item = { title: '修复接口', status: 'completed', evidenceIds: ['evidence-1'] }
    expect(parseExtraction(JSON.stringify({ items: [item, item] }), [message], [], [])).toHaveLength(1)
  })
  it('模型不能自动完成或修改手工待办与禅道任务', () => {
    for (const source of ['manual', 'zentao'] as const) {
      const task = { id: 'protected', reference: 'TASK-1', source, title: '修复接口', createdAt: message.timestamp, completedAt: null }
      const raw = JSON.stringify({ items: [{ taskId: task.id, title: '修复接口', status: 'completed', evidenceIds: [message.id] }] })
      expect(() => parseExtraction(raw, [message], [], [task])).toThrow('未知事项 ID')
    }
  })
  it('新事项的空ID按未提供处理，生成稳定ID由数据库负责', () => {
    const raw = JSON.stringify({ items: [{ taskId: '', title: '修复接口', status: 'todo', evidenceIds: ['evidence-1'] }] })
    expect(parseExtraction(raw, [message], [], [])[0].taskId).toBeUndefined()
  })
  it('简介超长时重新生成，不截断原文作为标题', () => {
    expect(() => parseExtraction(JSON.stringify({ items: [{ title: '长'.repeat(61), status: 'todo', evidenceIds: ['evidence-1'] }] }), [message], [], [])).toThrow()
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
