import { describe, expect, it } from 'vitest'
import type { SyncRun } from '../../shared/contracts.js'
import { loadConfig } from '../config.js'
import { ModelConnectionError } from '../modelRouting.js'
import type { SourceMessage } from '../records.js'
import type { Store } from '../store.js'
import { ExtractionBatcher } from './extractionBatcher.js'

const config = loadConfig({ DATABASE_URL: 'postgresql://app:test@localhost/test', WORKBENCH_SYNC_CONCURRENCY: '1' })

function message(session: string): SourceMessage {
  return { id: `m-${session}`, source: 'codex', sessionId: session, rootSessionId: session, projectPath: `/work/${session}`, role: 'user', timestamp: '2026-10-17T01:00:00.000Z', text: '整理测试记录' }
}

function run(): SyncRun {
  return { id: 'run', status: 'running', phase: 'scanning', startedAt: '2026-10-17T01:00:00.000Z', finishedAt: null,
    scannedFiles: 0, newMessages: 0, newTasks: 0, updatedTasks: 0, failedBatches: 0, errors: [] }
}

function harness(failure: Error | undefined) {
  const calls: string[] = []
  const reasons: string[] = []
  const store = {
    pendingMessages: async (_sources: string[] | undefined, after?: { timestamp: string; id: string }) => after ? [] : [message('a'), message('b')],
    resolveRoot: async (_source: string, sessionId: string) => sessionId,
    batchId: () => 'batch',
    startBatch: async () => true,
    contextMessages: async () => [],
    projectTasks: async () => [],
    applyExtraction: async () => ({ created: 1, updated: 0 }),
    failBatch: async (_id: string, reason: string) => { reasons.push(reason) },
  }
  const extractor = {
    extract: async (messages: SourceMessage[]) => {
      calls.push(messages[0].sessionId)
      if (messages[0].sessionId === 'a' && failure) throw failure
      return []
    },
    close: async () => {},
  }
  const current = run()
  return {
    calls, reasons, current,
    extract: () => new ExtractionBatcher(store as unknown as Store, extractor).extract({
      run: current, config, secrets: ['super-secret-value'], enabledSources: new Set(['codex']), isStopping: () => false,
      onError: (_run, reason) => { current.errors.push(reason) }, onProgress: async () => {},
    }),
  }
}

describe('抽取失败按错误码决定是否停止整轮', () => {
  it('连接失败即使文案不含密钥也会停止后续会话', async () => {
    const batch = harness(new ModelConnectionError('上游暂时无响应', 'CONNECTION'))
    await batch.extract()
    expect(batch.calls).toEqual(['a'])
    expect(batch.current.failedBatches).toBe(1)
    expect(batch.reasons).toEqual(['上游暂时无响应'])
  })
  it('超时文案即使包含密钥也继续抽取其他会话', async () => {
    const batch = harness(new ModelConnectionError('密钥看起来像故障但只是超时', 'TIMEOUT'))
    await batch.extract()
    expect(batch.calls).toEqual(['a', 'b'])
    expect(batch.current.failedBatches).toBe(1)
    expect(batch.current.newTasks).toBe(1)
  })
  it('输出校验失败只跳过当前会话，未知异常停止整轮且不回写上游正文', async () => {
    const invalid = harness(Object.assign(new Error('校验失败'), { validationFeedback: '输出包含未知来源证据' }))
    await invalid.extract()
    expect(invalid.calls).toEqual(['a', 'b'])
    expect(invalid.reasons[0]).toContain('未知来源证据')
    const unknown = harness(new Error('数据库失败 password=super-secret-value'))
    await unknown.extract()
    expect(unknown.calls).toEqual(['a'])
    expect(unknown.reasons).toEqual(['模型接入或抽取失败，请检查配置及套餐额度'])
    expect(unknown.reasons.join('')).not.toContain('super-secret-value')
  })
  it('缺少密钥会停止整轮，错误文案中的凭证会被隐藏', async () => {
    const batch = harness(new ModelConnectionError('尚未配置模型密钥 password=super-secret-value', 'NO_API_KEY'))
    await batch.extract()
    expect(batch.calls).toEqual(['a'])
    expect(batch.reasons[0]).toContain('[已隐藏凭证]')
    expect(batch.reasons[0]).not.toContain('super-secret-value')
  })
})
