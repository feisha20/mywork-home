import { z } from 'zod'
import { dailyReportItemMaxLength } from '../shared/dailyReports.js'
import { describe, expect, it } from 'vitest'
import { mcpClientConfig, mcpSchema, mcpTools, mcpPrompts } from '../shared/mcp.js'
import { isLocalMcpRequest } from './mcpAuth.js'
import { redactMcpValue } from './mcpService.js'

describe('MCP 本机边界与工具参数', () => {
  it('允许本机同源和无 Origin 的客户端，拒绝外部来源、伪装域名和 URL 注入', () => {
    expect(isLocalMcpRequest('127.0.0.1:8787', undefined)).toBe(true)
    expect(isLocalMcpRequest('localhost:8787', 'http://localhost:8787')).toBe(true)
    expect(isLocalMcpRequest('[::1]:8787', 'http://[::1]:8787')).toBe(true)
    for (const host of ['attacker.test:8787', '127.0.0.1.attacker.test', 'attacker@localhost:8787', 'localhost:8787/path', 'localhost:8787?x=1']) expect(isLocalMcpRequest(host, undefined)).toBe(false)
    for (const origin of ['http://attacker.test', 'http://localhost:5173', 'null', 'file:///tmp/data']) expect(isLocalMcpRequest('localhost:8787', origin)).toBe(false)
  })
  it('工具数量固定，分页限制和写入参数不能绕过服务校验', () => {
    expect(mcpTools).toHaveLength(14); expect(mcpPrompts).toHaveLength(4)
    expect(mcpSchema('search_work_items').parse({})).toMatchObject({ offset: 0, limit: 50, kind: 'all' })
    expect(mcpSchema('get_work_evidence').parse({ id: 'work' }).limit).toBe(5)
    expect(() => mcpSchema('search_work_items').parse({ limit: 101 })).toThrow()
    expect(() => mcpSchema('get_work_item').parse({ id: 'personal', includePersonal: true })).toThrow()
    expect(() => mcpSchema('update_todo').parse({ id: 'work', version: 'v' })).toThrow()
    expect(() => mcpSchema('save_report').parse({ type: 'daily', key: '2026-10-07', revision: 0, materialVersion: 'a'.repeat(64), items: [{ text: '一行\n第二行', taskIds: ['work'] }] })).toThrow()
  })
  it('助手保存日报允许同一项目的多句成果段落，仍拒绝异常长文', () => {
    const text = '完成日志日期归档与待办状态管理。补充日报复制和日志筛选交互，保留不同来源的工作记录，便于整理当天的项目进展；性能问题仍在排查，相关调整尚未完成。新增工作合并后继续保留原有成果与待处理状态。'
    expect(text.length).toBeGreaterThan(80)
    const input = { type: 'daily', key: '2026-10-14', revision: 0, materialVersion: 'a'.repeat(64),
      items: [{ text, taskIds: ['work'] }] }
    expect(mcpSchema('save_report').parse(input).items?.[0].text).toBe(text)
    const subItems = ['完成日志日期归档。', '性能问题仍在排查。']
    const structured = mcpSchema('save_report').parse({ ...input, items: [{ text: '概述', topic: '个人工作台', subItems, taskIds: ['work'] }] })
    expect(structured.items?.[0]).toMatchObject({ subItems, topic: '个人工作台', text: '概述' })
    expect(JSON.stringify(z.toJSONSchema(mcpSchema('save_report')))).toContain('subItems')

    expect(() => mcpSchema('save_report').parse({ ...input,
      items: [{ text: '长'.repeat(dailyReportItemMaxLength + 1), taskIds: ['work'] }] })).toThrow()
  })
  it('输出嵌套文字再次脱敏，保留稳定标识和日期', () => {
    const result = redactMcpValue({ id: 'a'.repeat(64), projectKey: `local:${'a'.repeat(32)}`, key: `local:${'a'.repeat(32)}`, quote: 'password=fixture-secret', nested: [{ text: '模型使用fixture-key' }], at: new Date('2026-10-07T01:00:00Z') }, ['fixture-key', 'fixture-secret'])
    expect(JSON.stringify(result)).not.toContain('fixture-key'); expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(result).toMatchObject({ id: 'a'.repeat(64), projectKey: `local:${'a'.repeat(32)}`, key: `local:${'a'.repeat(32)}`, at: '2026-10-07T01:00:00.000Z' })
  })
  it('两种配置都指向同一入口并使用 Bearer 认证', () => {
    const endpoint = 'http://127.0.0.1:8787/mcp', token = 'workbench_fixture'
    expect(mcpClientConfig('codex', endpoint, token)).toContain('http_headers = { Authorization = "Bearer workbench_fixture" }')
    expect(JSON.parse(mcpClientConfig('zcode', endpoint, token))).toEqual({ mcpServers: { mywork_home: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } } } })
  })
})
