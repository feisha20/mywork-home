import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { CAPTURE_SOURCES, SOURCES } from '../src/domain/workbench.js'
import { builtinCollectors, defaultPeriodicReportSchedule, modelSettingsSchema, pathCheckSchema, recordPreviewSchema, settingsUpdateSchema } from '../shared/settings.js'
import type { ChannelConfig, ChannelSummary, CollectorKind, PathScanResult, SettingsUpdate, WorkbenchSettings } from '../shared/settings.js'
import type { Config } from './config.js'
import { SourcePaths } from './sourcePaths.js'
import { previewCompatibleRecords } from './compatibleRecords.js'

interface SavedSettings extends Omit<SettingsUpdate, 'channels'> { channels: ChannelConfig[]; apiKey: string }
export class SettingsError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message) }
}

export function initialChannels(config: Config): ChannelConfig[] {
  const roots: Record<CollectorKind, string[]> = {
    auto: [], generic: [],
    codex: [config.CODEX_SESSIONS_DIR, config.CODEX_ARCHIVE_DIR], claude: [config.CLAUDE_PROJECTS_DIR],
    workbuddy: [config.WORKBUDDY_PROJECTS_DIR], zcode: [config.ZCODE_DB_DIR], gemini: [config.GEMINI_SESSIONS_DIR], none: [],
  }
  return CAPTURE_SOURCES.map((id) => ({ id, name: SOURCES[id].shortLabel, logo: SOURCES[id].logo,
    collector: builtinCollectors[id], enabled: true, pathMode: 'scan', paths: [...new Set(roots[builtinCollectors[id]].map(expanded))] }))
}
function expanded(path: string) { return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path) }

// 配置留在服务端运行目录；返回界面的对象永远不包含密钥。
export class SettingsService {
  private saving: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private logos = new Map<string, { contentType: string; body: Buffer; version: string }>()
  private constructor(private config: Config, private data: SavedSettings, private sourcePaths: SourcePaths) { this.cacheLogos() }
  static async open(config: Config) {
    const sourcePaths = await SourcePaths.detect()
    const file = join(config.WORKBENCH_RUNTIME_DIR, 'settings', 'workbench.json')
    let raw: string
    try { raw = await readFile(file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取工作台设置，请检查运行目录权限')
      const service = new SettingsService(config, { revision: 1,
        model: { baseUrl: config.WORKBENCH_LLM_BASE_URL, name: config.WORKBENCH_LLM_MODEL }, apiKey: config.WORKBENCH_LLM_API_KEY,
        sync: { enabled: config.SYNC_ENABLED === 'true', intervalMs: Math.min(86_400_000, Math.max(60_000, Math.ceil(config.SYNC_INTERVAL_MS / 60_000) * 60_000)) },
        dailyReportSchedule: { enabled: false, times: ['12:00', '18:00', '21:00'] },
        periodicReportSchedule: defaultPeriodicReportSchedule,
        channels: initialChannels(config) }, sourcePaths)
      await service.persist(service.data)
      return service
    }
    try {
      const parsed = JSON.parse(raw)
      const input = settingsUpdateSchema.parse(parsed)
      const apiKey = z.string().max(4096).parse(parsed.apiKey)
      await chmod(file, 0o600)
      return new SettingsService(config, { ...input, channels: input.channels as ChannelConfig[], apiKey }, sourcePaths)
    } catch { throw new Error('工作台设置无法读取，请检查服务端配置文件') }
  }
  view(): WorkbenchSettings {
    const unresolvedPaths: string[] = []
    const channels = this.channels().map((channel) => ({ ...channel, paths: channel.paths.map((path) => {
      const location = this.sourcePaths.resolve(path)
      if (!location.hostPath) unresolvedPaths.push(location.path)
      return location.hostPath ?? location.path
    }) }))
    return { revision: this.data.revision, model: { baseUrl: this.data.model.baseUrl, name: this.data.model.name, hasApiKey: !!this.data.apiKey },
      sync: { ...this.data.sync }, dailyReportSchedule: { ...this.data.dailyReportSchedule }, periodicReportSchedule: { ...this.data.periodicReportSchedule }, channels, pathEnvironment: this.sourcePaths.environment, unresolvedPaths: [...new Set(unresolvedPaths)] }
  }
  runtimeConfig(): Config {
    return { ...this.config, WORKBENCH_LLM_BASE_URL: this.data.model.baseUrl, WORKBENCH_LLM_MODEL: this.data.model.name,
      WORKBENCH_LLM_API_KEY: this.data.apiKey, SYNC_ENABLED: this.data.sync.enabled ? 'true' : 'false', SYNC_INTERVAL_MS: this.data.sync.intervalMs }
  }
  channels() { return structuredClone(this.data.channels) }
  dailyReportSchedule() { return structuredClone(this.data.dailyReportSchedule) }
  periodicReportSchedule() { return structuredClone(this.data.periodicReportSchedule) }
  // 首页轮询只传图片地址，避免每次刷新重复传输所有上传的图片。
  summaries(): ChannelSummary[] {
    return this.data.channels.map(({ paths: _paths, pathMode: _mode, mapping: _mapping, ...channel }) => ({ ...channel,
      logo: this.logos.has(channel.id) ? `/api/channel-logos/${channel.id}?v=${this.logos.get(channel.id)!.version}` : channel.logo }))
  }
  logo(id: string, version?: string) {
    const logo = this.logos.get(id)
    return logo && (!version || version === logo.version) ? logo : null
  }
  private cacheLogos() {
    this.logos.clear()
    for (const channel of this.data.channels) {
      const match = channel.logo.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
      if (!match) continue
      const body = Buffer.from(match[2], 'base64')
      this.logos.set(channel.id, { contentType: match[1], body, version: createHash('sha256').update(body).digest('hex').slice(0, 20) })
    }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  save(raw: unknown): Promise<WorkbenchSettings> {
    const input = settingsUpdateSchema.parse(raw)
    const action = this.saving.then(async () => {
      if (input.revision !== this.data.revision) throw new SettingsError('设置已在其他页面更新，请重新打开设置后再保存', 409)
      for (const current of this.data.channels) {
        const next = input.channels.find((entry) => entry.id === current.id)
        if (!next) throw new SettingsError('已有渠道请使用开关停用，以保留历史记录')
        const compatible = ['auto', 'generic'].includes(current.collector) && ['auto', 'generic', 'none'].includes(next.collector)
        if (next.collector !== current.collector && current.collector !== 'none' && !compatible) throw new SettingsError('已接入渠道的记录格式不可更改，请新增渠道')
      }
      const next: SavedSettings = { revision: this.data.revision + 1,
        model: { baseUrl: input.model.baseUrl.replace(/\/+$/, ''), name: input.model.name },
        apiKey: input.model.clearApiKey ? '' : input.model.apiKey || this.data.apiKey,
        sync: input.sync, dailyReportSchedule: input.dailyReportSchedule, periodicReportSchedule: input.periodicReportSchedule, channels: input.channels.map((channel) => ({ ...channel, id: channel.id as ChannelConfig['id'], paths: [...new Set(channel.paths.map((path) => {
          const location = this.sourcePaths.resolve(path)
          const existing = this.data.channels.find((entry) => entry.id === channel.id)?.paths.includes(path)
          if (location.unmounted && !existing) throw new SettingsError(`“${channel.name}”的本机目录尚未授权访问，请在部署配置中添加该目录后再保存：${path}`)
          return location.path
        }))] })) }
      await this.persist(next)
      this.data = next
      this.cacheLogos()
      for (const listener of this.listeners) listener()
      return this.view()
    })
    this.saving = action.then(() => {}, () => {})
    return action
  }
  private async persist(data: SavedSettings) {
    const directory = join(this.config.WORKBENCH_RUNTIME_DIR, 'settings')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporary = join(directory, `.workbench-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(directory, 'workbench.json'))
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
  async scan(collector: CollectorKind, draftPaths: string[] = []): Promise<PathScanResult> {
    if (collector === 'none') return { paths: [], checked: 0, message: '该渠道尚未接入采集器，可先设置名称与 Logo' }
    const universal = collector === 'auto' || collector === 'generic'
    const defaults = initialChannels(this.config).filter((channel) => universal || channel.collector === collector).flatMap((channel) => channel.paths)
    const native: Record<Exclude<CollectorKind, 'none'>, string[]> = {
      auto: [], generic: [],
      codex: [join(homedir(), '.codex/sessions'), join(homedir(), '.codex/archived_sessions')],
      claude: [join(homedir(), '.claude/projects')], workbuddy: [join(homedir(), '.workbuddy/projects')],
      zcode: [join(homedir(), '.zcode/cli/db')], gemini: [join(homedir(), '.gemini/tmp')],
    }
    const candidates = [...new Set([...draftPaths, ...defaults, ...this.data.channels.filter((channel) => channel.collector === collector).flatMap((channel) => channel.paths), ...native[collector]]
      .map((path) => this.sourcePaths.resolve(path)).filter((location) => !location.unmounted).map((location) => location.path))]
    const paths: string[] = []
    for (const path of candidates) {
      try {
        if (!(await stat(path)).isDirectory()) continue
        await readdir(path)
        if (collector === 'zcode' && !(await stat(join(path, 'db.sqlite'))).isFile()) continue
        paths.push(path)
      } catch { /* 缺失或无权读取的候选目录不进入扫描结果。 */ }
    }
    const locations = paths.map((path) => this.sourcePaths.resolve(path))
    return { paths: locations.map((location) => location.hostPath ?? location.path), unresolvedPaths: locations.filter((location) => !location.hostPath).map((location) => location.path),
      checked: candidates.length, message: paths.length ? `找到 ${paths.length} 个可读取目录，${universal ? '勾选并保存后开始使用' : '保存后开始使用'}` : '未找到可读取目录，请手动填写本机目录并检查是否已授权访问' }
  }
  checkPaths(raw: unknown) {
    const { collector, paths } = pathCheckSchema.parse(raw)
    return this.sourcePaths.check(collector, paths)
  }
  async previewRecords(raw: unknown) {
    const input = recordPreviewSchema.parse(raw)
    if (!['auto', 'generic'].includes(input.collector)) throw new SettingsError('此读取方式无需自动识别，请使用已有采集器')
    if (!input.paths.length) throw new SettingsError('请先填写或扫描本机会话目录')
    const locations = input.paths.map((path) => this.sourcePaths.resolve(path))
    if (locations.some((location) => location.unmounted)) throw new SettingsError('工作台尚未获准访问该本机目录，请在部署配置中添加目录后重试')
    const config = this.runtimeConfig()
    return previewCompatibleRecords(locations.map((location) => location.path), input.collector as 'auto' | 'generic', input.mapping,
      [config.WORKBENCH_LLM_API_KEY, decodeURIComponent(new URL(config.DATABASE_URL).password)])
  }
  async testModel(raw: unknown): Promise<{ message: string }> {
    const model = modelSettingsSchema.parse(raw)
    const apiKey = model.clearApiKey ? '' : model.apiKey || this.data.apiKey
    if (!apiKey) throw new SettingsError('请先填写 API Key')
    let response: Response
    try {
      response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ model: model.name, messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 16, stream: false }) })
    } catch { throw new SettingsError('模型连接失败或超时，请检查地址与网络', 502) }
    if (!response.ok) {
      await response.body?.cancel()
      const reasons: Record<number, string> = { 401: '密钥无效或已过期', 403: '模型访问权限不足', 404: '模型名称或基础地址不正确', 429: '请求受限或额度不足' }
      throw new SettingsError(reasons[response.status] ?? '上游模型请求失败，请检查配置', 502)
    }
    const result = await response.json().catch(() => null)
    if (!result?.choices?.length) throw new SettingsError('接口未返回兼容的模型响应，请检查基础地址', 502)
    return { message: '连接成功，模型可以正常响应' }
  }
}
