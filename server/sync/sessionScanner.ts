import { DirectoryCache } from '../directoryCache.js'
import { stat } from 'node:fs/promises'
import type { SyncRun, WorkbenchSnapshot } from '../../shared/contracts.js'
import type { ChannelConfig } from '../../shared/settings.js'
import {
  classifyCompatibleFile,
  isCompatibleDatabase,
  listCompatibleCandidates,
  readCompatibleDelta,
  recordReaderSignature,
  type CompatibleRecordFile,
} from '../compatibleRecords.js'
import { listGeminiRecordFiles, readGeminiDelta, type GeminiRecordFile } from '../gemini.js'
import { digest, isRecordDataError, listRecordFiles, readDelta, type Source, type SourceMessage } from '../records.js'
import type { Store } from '../store.js'
import { ZcodeReader } from '../zcode.js'

export interface SessionScannerContext {
  run: SyncRun
  channel: ChannelConfig
  cutoff: string
  secrets: string[]
  sources: WorkbenchSnapshot['sources']
  isStopping: () => boolean
  onError: (run: SyncRun, message: string) => void
  onFailRecord: (run: SyncRun, source: Source, file: string, fingerprint: string) => Promise<void>
  onProgress: (run: SyncRun) => Promise<void>
}

export class SessionScanner {
  private directories = new DirectoryCache()
  private completedFiles = new Map<string, string>()
  private cacheSince = Date.now()
  private fileFormats = new Map<string, { fingerprint: string; file: CompatibleRecordFile }>()

  constructor(private readonly store: Store) {}

  clearFormatsCache() {
    this.fileFormats.clear()
    this.directories.clear()
    this.completedFiles.clear()
    this.cacheSince = Date.now()
  }

  async scanChannel(ctx: SessionScannerContext): Promise<void> {
    const { run, channel, cutoff, secrets, sources, isStopping, onError, onFailRecord, onProgress } = ctx
    if (Date.now() - this.cacheSince >= 3_600_000) this.clearFormatsCache()
    const source = channel.id as Source
    const modeKey = JSON.stringify([channel.collector, channel.mapping])
    const completedKey = (path: string) => JSON.stringify([source, path, modeKey])
    const fingerprintOf = (info: Awaited<ReturnType<typeof stat>>) => digest(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    const remember = (path: string, fingerprint: string) => {
      if (this.completedFiles.size >= 10_000) this.completedFiles.clear()
      this.completedFiles.set(completedKey(path), fingerprint)
    }
    const readDirectory = (path: string) => this.directories.read(path)

    for (const root of channel.paths) {
      if (isStopping()) break
      let collector = channel.collector
      const universal = collector === 'auto' || collector === 'generic'
      if (collector === 'auto' && isCompatibleDatabase(root)) collector = 'zcode'
      const cursorKey = (path: string) => source.startsWith('custom-') ? `channel:${source}:${path}` : path
      const mapped = (delta: { messages: SourceMessage[]; cursor: import('../records.js').Cursor }, path: string) => ({
        messages: delta.messages.map((message) => ({ ...message, source, id: source.startsWith('custom-') ? digest(`${source}:${message.id}`) : message.id })),
        cursor: { ...delta.cursor, source, path: cursorKey(path) },
      })

      run.activeSource = source
      await this.store.saveRun(run)

      if (collector === 'zcode') {
        let reader: ZcodeReader | undefined
        try {
          reader = new ZcodeReader(root)
          const sessions = reader.sessions(cutoff)
          sources[source].available = true
          for (const session of sessions) {
            if (isStopping()) break
            try {
              const path = reader.cursorPath(session)
              const cursor = await this.store.cursor(cursorKey(path))
              const delta = reader.readDelta(session, cursor, cutoff, secrets)
              const data = mapped(delta, path)
              run.newMessages += await this.store.ingest(data.messages, data.cursor)
              run.skippedRecords = (run.skippedRecords ?? 0) + delta.invalid
            } catch {
              onError(run, `${source}：部分会话读取失败，下次同步重试`)
            }
          }
          run.scannedFiles++
        } catch {
          sources[source].error = '会话数据库不存在、无法读取或格式不兼容'
          onError(run, `${source}：${sources[source].error}`)
        } finally {
          reader?.close()
        }
        continue
      }

      if (collector === 'none') continue

      let files: (GeminiRecordFile | CompatibleRecordFile)[]
      try {
        if (universal) {
          files = []
          let unsupported = 0
          for (const path of await listCompatibleCandidates(root, readDirectory)) {
            try {
              const info = await stat(path)
              if (this.completedFiles.get(completedKey(path)) === fingerprintOf(info)) continue
              const key = cursorKey(path)
              const fingerprint = digest(`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${collector}:${JSON.stringify(channel.mapping)}`)
              let file = this.fileFormats.get(key)?.fingerprint === fingerprint ? this.fileFormats.get(key)!.file : null
              if (!file) {
                const previous = await this.store.cursor(key)
                const format = previous?.context.readerFormat as CompatibleRecordFile['format'] | undefined
                if (previous && format && previous.context.readerMode === collector && previous.inode === String(info.ino) && previous.offset === info.size && previous.modifiedAt === Math.trunc(info.mtimeMs)
                  && previous.context.readerSignature === recordReaderSignature(format, channel.mapping)) {
                  file = { path, format, projectPath: previous.context.projectPath, parentSessionId: previous.context.parentSessionId, signature: previous.context.readerSignature }
                } else {
                  file = await classifyCompatibleFile(path, collector as 'auto' | 'generic', channel.mapping)
                }
                if (file) {
                  if (this.fileFormats.size >= 10_000) this.fileFormats.clear()
                  this.fileFormats.set(key, { fingerprint, file })
                }
              }
              if (file) files.push(file)
              else unsupported++
            } catch {
              unsupported++
            }
          }
          if (unsupported) {
            sources[source].error = `${unsupported} 个文件未识别或无法读取，请在设置中检测记录或配置字段对应关系`
            onError(run, `${channel.name}：${sources[source].error}`)
          }
        } else {
          files = collector === 'gemini'
            ? await listGeminiRecordFiles(root, readDirectory)
            : (await listRecordFiles(root, readDirectory)).map((path) => ({ path, projectPath: '', parentSessionId: null }))
        }
        sources[source].available = true
      } catch {
        sources[source].error = '记录目录不存在或无法读取'
        onError(run, `${source}：记录目录不存在或无法读取`)
        continue
      }

      for (const record of files) {
        if (isStopping()) break
        const file = record.path
        let info
        try {
          info = await stat(file)
        } catch {
          await onFailRecord(run, source, cursorKey(file), 'unreadable')
          continue
        }
        const completedFingerprint = fingerprintOf(info)
        if (this.completedFiles.get(completedKey(file)) === completedFingerprint) continue
        const key = cursorKey(file)
        let cursor = await this.store.cursor(key)
        if (!cursor && info.mtimeMs < Date.parse(cutoff)) continue
        const signature = 'signature' in record ? record.signature : ''
        const fingerprint = digest(`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}${signature ? `:${signature}` : ''}`)
        if (await this.store.recordIgnored(key, fingerprint)) {
          run.ignoredFiles = (run.ignoredFiles ?? 0) + 1
          continue
        }
        if (cursor && cursor.inode === String(info.ino) && cursor.offset === info.size && cursor.modifiedAt === Math.trunc(info.mtimeMs)
          && (!signature || cursor.context.readerSignature === signature)) {
          remember(file, completedFingerprint)
          continue
        }

        let more = true, failed = false
        while (more && !isStopping()) {
          let delta
          try {
            delta = 'format' in record
              ? await readCompatibleDelta(record, source, cursor, cutoff, secrets, channel.mapping)
              : collector === 'gemini'
                ? await readGeminiDelta(record, cursor, cutoff, secrets)
                : await readDelta(file, collector as 'codex' | 'claude' | 'workbuddy', cursor, cutoff, secrets)
          } catch {
            await onFailRecord(run, source, key, fingerprint)
            failed = true
            break
          }

          delta.cursor.context.readerMode = collector
          const data = mapped(delta, file)
          try {
            run.newMessages += await this.store.ingest(data.messages, data.cursor, 'reconcile' in delta && delta.reconcile === true)
          } catch (error) {
            if (!isRecordDataError(error)) throw error
            await onFailRecord(run, source, key, fingerprint)
            failed = true
            break
          }
          cursor = data.cursor
          more = delta.more
          if (delta.blocked) {
            await onFailRecord(run, source, key, fingerprint)
            failed = true
            break
          }
          run.skippedRecords = (run.skippedRecords ?? 0) + delta.invalid
        }

        if (!failed && !isStopping()) {
          await this.store.clearRecordFailure(key)
          if (cursor?.offset === info.size && cursor.modifiedAt === Math.trunc(info.mtimeMs)) remember(file, completedFingerprint)
        }
        run.scannedFiles++
        if (run.scannedFiles % 20 === 0) {
          await onProgress(run)
        }
      }
    }
  }
}
