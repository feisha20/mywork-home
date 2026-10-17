import type { SyncRun } from '../../shared/contracts.js'
import type { Config } from '../config.js'
import { extractionFailureReason, type Extractor } from '../harness.js'
import { redact } from '../redact.js'
import type { SourceMessage } from '../records.js'
import type { Store } from '../store.js'

export function messageBatches(messages: SourceMessage[], maxCharacters = 30000): SourceMessage[][] {
  const result: SourceMessage[][] = []
  let batch: SourceMessage[] = [], size = 0
  for (const message of messages) {
    const length = message.text.length
    if (batch.length && (size + length > maxCharacters || batch.length >= 30)) { result.push(batch); batch = []; size = 0 }
    // 保留来源ID；单条巨长文字取首尾，避免工具粘贴吞掉上下文窗口。
    const text = length > maxCharacters ? `${message.text.slice(0, maxCharacters / 2)}\n[中间超长内容已省略]\n${message.text.slice(-maxCharacters / 2)}` : message.text
    batch.push({ ...message, text }); size += text.length
  }
  if (batch.length) result.push(batch)
  return result
}

export interface BatchExtractionContext {
  run: SyncRun
  config: Config
  secrets: string[]
  enabledSources: Set<string>
  isStopping: () => boolean
  onError: (run: SyncRun, message: string) => void
  onProgress: (run: SyncRun) => Promise<void>
}

export class ExtractionBatcher {
  constructor(
    private readonly store: Store,
    private readonly extractor: Extractor,
  ) {}

  async extract(ctx: BatchExtractionContext): Promise<void> {
    const { run, config, secrets, enabledSources, isStopping, onError, onProgress } = ctx
    run.phase = 'extracting'
    run.activeSource = null
    await onProgress(run)

    const rootCache = new Map<string, string>()
    const blockedGroups = new Set<string>()
    let modelUnavailable = false

    const processGroup = async ([key, messages]: [string, SourceMessage[]]) => {
      if (blockedGroups.has(key)) return
      for (const batch of messageBatches(messages)) {
        if (isStopping() || modelUnavailable) break
        const id = this.store.batchId(batch)
        if (!await this.store.startBatch(id, key, batch)) continue
        try {
          const context = await this.store.contextMessages(batch[0].source, batch[0].rootSessionId, batch[0].timestamp, batch[0].projectPath)
          const tasks = await this.store.projectTasks(batch[0].projectPath)
          run.phase = 'extracting'
          run.activeSource = batch[0].source
          await onProgress(run)
          const items = await this.extractor.extract(batch, context, tasks, config)
          run.phase = 'saving'
          await onProgress(run)
          const counts = await this.store.applyExtraction(id, batch, context, items)
          run.newTasks += counts.created
          run.updatedTasks += counts.updated
          run.processedBatches = (run.processedBatches ?? 0) + 1
          await onProgress(run)
        } catch (error) {
          // 不存储上游完整错误，避免 SDK 把提示词或请求头带入日志。
          const reason = extractionFailureReason(error) ?? (error instanceof Error && /超时|校验|密钥|正在关闭/.test(error.message) ? redact(error.message, secrets) : '模型接入或抽取失败，请检查配置及套餐额度')
          await this.store.failBatch(id, reason)
          run.failedBatches++
          onError(run, reason)
          if (/密钥|模型接入/.test(reason)) modelUnavailable = true
          // 当前会话依赖前文；本批失败后不继续处理该会话的后续消息。
          blockedGroups.add(key)
          break
        }
      }
    }

    let after: { timestamp: string; id: string } | undefined
    while (!isStopping() && !modelUnavailable) {
      const page = await this.store.pendingMessages([...enabledSources], after, 500)
      if (!page.length) break
      const groups = new Map<string, SourceMessage[]>()
      for (const message of page) {
        if (!enabledSources.has(message.source)) continue
        const cacheKey = `${message.source}:${message.sessionId}`
        let root = rootCache.get(cacheKey)
        if (!root) {
          root = await this.store.resolveRoot(message.source, message.sessionId)
          rootCache.set(cacheKey, root)
        }
        message.rootSessionId = root
        const key = `${message.source}:${root}:${message.projectPath}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(message)
      }
      const entries = [...groups.entries()]
      let nextIndex = 0
      await Promise.all(Array.from({ length: Math.min(config.WORKBENCH_SYNC_CONCURRENCY, entries.length) }, async () => {
        while (nextIndex < entries.length && !isStopping() && !modelUnavailable) {
          await processGroup(entries[nextIndex++]!)
        }
      }))
      const last = page.at(-1)!
      after = { timestamp: last.timestamp, id: last.id }
      if (page.length < 500) break
    }
  }
}
