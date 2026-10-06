import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.js'
import { SettingsService } from './settings.js'
import { SourcePaths } from './sourcePaths.js'
import { settingsDraft } from '../src/domain/settings.js'
import { createApp } from './app.js'
import { SyncService } from './sync.js'
import { DailyReportService } from './dailyReport.js'
import type { Store } from './store.js'
import { EMPTY_RECORD_MAPPING } from '../shared/settings.js'

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => '/__workbench_settings_test_home__' }))
let directory: string
let settings: SettingsService
let config: ReturnType<typeof loadConfig>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbench-settings-'))
  config = loadConfig({ DATABASE_URL: 'postgresql://workbench:test@localhost/workbench_test', WORKBENCH_RUNTIME_DIR: directory,
    WORKBENCH_LLM_API_KEY: '配置测试专用密钥', SYNC_ENABLED: 'false', STATIC_DIR: join(directory, 'no-static'),
    CODEX_SESSIONS_DIR: join(directory, 'codex'), CODEX_ARCHIVE_DIR: join(directory, 'archive') })
  settings = await SettingsService.open(config)
})
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })

describe('设置持久化与密钥边界', () => {
  it('禅道密码仅在服务端保存，留空保留、修改身份重填、停用后可清除，重启保留配置', async () => {
    const input = settingsDraft(settings.view()), channel = input.channels.find((entry) => entry.id === 'zentao')!
    channel.enabled = true; channel.zentao = { baseUrl: 'https://pm.example/zentao/', account: 'linjt', password: '禅道测试专用密码' }
    const saved = await settings.save(input)
    expect(saved.channels.find((entry) => entry.id === 'zentao')?.zentao).toEqual({ baseUrl: 'https://pm.example/zentao', account: 'linjt', hasPassword: true })
    expect(JSON.stringify(saved)).not.toContain('禅道测试专用密码')
    expect(JSON.stringify(settings.summaries())).not.toContain('pm.example')
    const reopened = await SettingsService.open(config)
    expect(reopened.view()).toEqual(saved)
    expect(reopened.zentaoConnection()?.password).toBe('禅道测试专用密码')
    expect(reopened.runtimeConfig().sourceSecrets).toContain('禅道测试专用密码')
    await reopened.save(settingsDraft(saved))
    expect(reopened.zentaoConnection()?.password).toBe('禅道测试专用密码')
    const changed = settingsDraft(reopened.view()); changed.channels.find((entry) => entry.id === 'zentao')!.zentao!.baseUrl = 'https://other.example/zentao'
    await expect(reopened.save(changed)).rejects.toThrow('更换地址或账号')
    const clear = settingsDraft(reopened.view()), target = clear.channels.find((entry) => entry.id === 'zentao')!
    target.zentao!.clearPassword = true
    await expect(reopened.save(clear)).rejects.toThrow('填写密码')
    target.enabled = false
    await reopened.save(clear)
    expect((await SettingsService.open(config)).zentaoConnection()).toBeNull()
    expect(reopened.view().channels.find((entry) => entry.id === 'zentao')?.zentao?.hasPassword).toBe(false)
  })
  it('旧版禅道占位配置自动升级为 V2，其他渠道配置和模型密钥完整保留', async () => {
    const file = join(directory, 'settings/workbench.json'), raw = JSON.parse(await readFile(file, 'utf8'))
    raw.channels.find((entry: { id: string }) => entry.id === 'zentao').collector = 'none'
    raw.channels.find((entry: { id: string }) => entry.id === 'zentao').enabled = true
    delete raw.zentaoPassword
    await writeFile(file, JSON.stringify(raw))
    const upgraded = await SettingsService.open(config)
    expect(upgraded.view().channels.find((entry) => entry.id === 'zentao')).toMatchObject({ collector: 'zentao', enabled: false, paths: [], zentao: { hasPassword: false } })
    expect(upgraded.runtimeConfig().WORKBENCH_LLM_API_KEY).toBe(config.WORKBENCH_LLM_API_KEY)
    expect(upgraded.channels().filter((entry) => entry.id !== 'zentao')).toEqual(settings.channels().filter((entry) => entry.id !== 'zentao'))
    expect((await SettingsService.open(config)).view()).toEqual(upgraded.view())
  })
  it('首次继承环境默认值，接口只返回密钥是否存在，文件仅当前用户可读写', async () => {
    expect(settings.view().model).toEqual({ baseUrl: config.WORKBENCH_LLM_BASE_URL, name: config.WORKBENCH_LLM_MODEL, hasApiKey: true })
    expect(JSON.stringify(settings.view())).not.toContain(config.WORKBENCH_LLM_API_KEY)
    expect((await stat(join(directory, 'settings/workbench.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'settings'))).mode & 0o777).toBe(0o700)
  })
  it('排序、模型和路径重启后保留，留空保留密钥，替换与清除均可生效', async () => {
    const input = settingsDraft(settings.view())
    input.channels.unshift(input.channels.splice(2, 1)[0])
    input.channels[0].paths = [join(directory, '新的目录')]; input.channels[0].pathMode = 'manual'
    input.model.name = '新的模型'; input.model.baseUrl = 'https://model.example/v1/'
    const saved = await settings.save(input)
    const reloaded = await SettingsService.open({ ...config, WORKBENCH_LLM_MODEL: '旧默认模型', WORKBENCH_LLM_API_KEY: '旧环境密钥' })
    expect(reloaded.view()).toEqual(saved)
    expect(reloaded.runtimeConfig().WORKBENCH_LLM_API_KEY).toBe(config.WORKBENCH_LLM_API_KEY)
    expect(reloaded.runtimeConfig().WORKBENCH_LLM_BASE_URL).toBe('https://model.example/v1')
    expect(reloaded.view().channels[0]).toMatchObject({ id: 'codex', pathMode: 'manual', paths: [join(directory, '新的目录')] })
    const replacement = settingsDraft(reloaded.view()); replacement.model.apiKey = '替换用测试密钥'
    await reloaded.save(replacement)
    expect(reloaded.runtimeConfig().WORKBENCH_LLM_API_KEY).toBe('替换用测试密钥')
    const clear = settingsDraft(reloaded.view()); clear.model.clearApiKey = true
    await reloaded.save(clear)
    expect((await SettingsService.open(config)).view().model.hasApiKey).toBe(false)
  })
  it('定时生成日报配置重启后保留，旧版缺少字段时自动补充默认配置', async () => {
    expect(settings.view().dailyReportSchedule).toEqual({ enabled: false, times: ['12:00', '18:00', '21:00'] })
    const draft = settingsDraft(settings.view())
    draft.dailyReportSchedule = { enabled: true, times: ['17:30', '11:00'] }
    const saved = await settings.save(draft)
    // times 自动升序排列
    expect(saved.dailyReportSchedule).toEqual({ enabled: true, times: ['11:00', '17:30'] })
    const reloaded = await SettingsService.open(config)
    expect(reloaded.view().dailyReportSchedule).toEqual({ enabled: true, times: ['11:00', '17:30'] })
    expect(reloaded.dailyReportSchedule()).toEqual({ enabled: true, times: ['11:00', '17:30'] })

    // 测试旧版配置文件缺失 dailyReportSchedule 字段时能够平滑升级
    const file = join(directory, 'settings/workbench.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    delete raw.dailyReportSchedule
    await writeFile(file, JSON.stringify(raw))
    const upgraded = await SettingsService.open(config)
    expect(upgraded.view().dailyReportSchedule).toEqual({ enabled: false, times: ['12:00', '18:00', '21:00'] })
  })
  it('并发保存只接受一个版本，失败请求不会清除成功保存的配置', async () => {
    const left = settingsDraft(settings.view()), right = settingsDraft(settings.view())
    left.model.name = '先保存的模型'; right.model.name = '过期的模型'
    const results = await Promise.allSettled([settings.save(left), settings.save(right)])
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected'])
    expect(settings.view().model.name).toBe('先保存的模型')
    expect(settings.view().revision).toBe(2)
  })
  it('磁盘保存失败时保留原配置，恢复目录后可以重试', async () => {
    const old = settings.view(), input = settingsDraft(old); input.model.name = '未成功的模型'
    await rename(join(directory, 'settings'), join(directory, 'backup'))
    await writeFile(join(directory, 'settings'), '模拟不可写的目录')
    await expect(settings.save(input)).rejects.toThrow()
    expect(settings.view()).toEqual(old)
    await rm(join(directory, 'settings'))
    await rename(join(directory, 'backup'), join(directory, 'settings'))
    await settings.save(input)
    expect(settings.view().model.name).toBe('未成功的模型')
  })
  it('损坏的配置文件不会被环境默认值悄悄覆盖', async () => {
    const file = join(directory, 'settings/workbench.json')
    await writeFile(file, '{无效配置')
    await expect(SettingsService.open(config)).rejects.toThrow('设置无法读取')
    expect(await readFile(file, 'utf8')).toBe('{无效配置')
  })
  it('支持先展示新渠道，再接入已有记录格式，已有采集器不能换格式或删除', async () => {
    const input = settingsDraft(settings.view())
    input.channels.push({ id: 'custom-editor', name: '新编辑器', logo: '', collector: 'none', enabled: true, pathMode: 'scan', paths: [] })
    await settings.save(input)
    const next = settingsDraft(settings.view())
    next.channels.at(-1)!.collector = 'codex'; next.channels.at(-1)!.paths = [config.CODEX_SESSIONS_DIR]
    await settings.save(next)
    const changed = settingsDraft(settings.view()); changed.channels.at(-1)!.collector = 'claude'
    await expect(settings.save(changed)).rejects.toThrow('记录格式不可更改')
    const removed = settingsDraft(settings.view()); removed.channels.pop()
    await expect(settings.save(removed)).rejects.toThrow('开关停用')
  })
  it('通用字段随设置持久保存，允许在自动识别与通用读取之间切换，首页不携带字段配置', async () => {
    const input = settingsDraft(settings.view())
    input.channels.push({ id: 'custom-compatible', name: '其他工具', logo: '', collector: 'auto', enabled: true, pathMode: 'manual', paths: [config.CODEX_SESSIONS_DIR] })
    await settings.save(input)
    const next = settingsDraft(settings.view())
    next.channels.at(-1)!.collector = 'generic'; next.channels.at(-1)!.mapping = { ...EMPTY_RECORD_MAPPING, text: 'body.text', role: 'speaker', timestamp: 'created' }
    await settings.save(next)
    expect((await SettingsService.open(config)).view()).toEqual(settings.view())
    expect(settings.summaries().at(-1)).not.toHaveProperty('mapping')
    const restored = settingsDraft(settings.view()); restored.channels.at(-1)!.collector = 'auto'
    await settings.save(restored)
    expect(settings.view().channels.at(-1)!.mapping?.text).toBe('body.text')
    const unsafe = settingsDraft(settings.view()); unsafe.channels.at(-1)!.mapping!.text = '__proto__.polluted'
    expect(() => settings.save(unsafe)).toThrow()
  })
  it('自动识别扫描包含草稿目录和常用目录，不改变已保存的渠道路径', async () => {
    await mkdir(config.CODEX_SESSIONS_DIR)
    const extra = join(directory, 'extra-tool'); await mkdir(extra)
    const before = settings.view()
    expect((await settings.scan('auto', [extra])).paths).toEqual([extra, config.CODEX_SESSIONS_DIR])
    expect(settings.view()).toEqual(before)
  })
  it('扫描只返回可读取目录，保留 Codex 会话和归档两个目录', async () => {
    await mkdir(config.CODEX_SESSIONS_DIR); await mkdir(config.CODEX_ARCHIVE_DIR)
    expect(await settings.scan('codex')).toMatchObject({ paths: [config.CODEX_SESSIONS_DIR, config.CODEX_ARCHIVE_DIR] })
    expect((await settings.scan('none')).paths).toEqual([])
    const input = settingsDraft(settings.view()); input.channels.find((entry) => entry.id === 'zcode')!.paths = [join(directory, 'zcode')]
    await settings.save(input); await mkdir(join(directory, 'zcode'))
    expect((await settings.scan('zcode')).paths).toEqual([])
    await writeFile(join(directory, 'zcode/db.sqlite'), '')
    expect((await settings.scan('zcode')).paths).toEqual([join(directory, 'zcode')])
  })
  it('设置与扫描返回 Mac 路径，保存和重新打开后仍显示 Mac 路径，采集器保留实际读取路径', async () => {
    const detect = vi.spyOn(SourcePaths, 'detect').mockResolvedValue(new SourcePaths('container', [
      { hostPath: '/Users/linjt/.codex/sessions', containerPath: config.CODEX_SESSIONS_DIR, readOnly: true },
    ]))
    try {
      settings = await SettingsService.open(config)
      await mkdir(config.CODEX_SESSIONS_DIR)
      expect(settings.view().channels.find((entry) => entry.id === 'codex')!.paths[0]).toBe('/Users/linjt/.codex/sessions')
      expect((await settings.scan('codex')).paths).toEqual(['/Users/linjt/.codex/sessions'])
      const input = settingsDraft(settings.view())
      input.channels.find((entry) => entry.id === 'codex')!.paths = ['/Users/linjt/.codex/sessions', config.CODEX_SESSIONS_DIR]
      const saved = await settings.save(input)
      expect(saved.channels.find((entry) => entry.id === 'codex')!.paths).toEqual(['/Users/linjt/.codex/sessions'])
      expect(settings.channels().find((entry) => entry.id === 'codex')!.paths).toEqual([config.CODEX_SESSIONS_DIR])
      expect(JSON.parse(await readFile(join(directory, 'settings/workbench.json'), 'utf8')).channels.find((entry: { id: string }) => entry.id === 'codex').paths).toEqual([config.CODEX_SESSIONS_DIR])
      const reopened = await SettingsService.open(config)
      expect(reopened.view()).toEqual(saved)
      await reopened.save(settingsDraft(reopened.view()))
      expect(reopened.channels().find((entry) => entry.id === 'codex')!.paths).toEqual([config.CODEX_SESSIONS_DIR])
      const invalid = settingsDraft(saved)
      invalid.channels.find((entry) => entry.id === 'codex')!.paths = ['/Users/linjt/未挂载目录']
      await expect(settings.save(invalid)).rejects.toThrow('本机目录尚未授权访问')
      expect(settings.view()).toEqual(saved)
    } finally { detect.mockRestore() }
  })
  it('无法识别本机路径时提供标记，修改其他设置仍保留已有采集目录', async () => {
    const detect = vi.spyOn(SourcePaths, 'detect').mockResolvedValue(new SourcePaths('container', []))
    try {
      settings = await SettingsService.open({ ...config, WORKBENCH_RUNTIME_DIR: join(directory, 'unmapped'), CODEX_SESSIONS_DIR: '/home/collector/sessions', CODEX_ARCHIVE_DIR: '/home/collector/archive' })
      const before = settings.channels()
      expect(settings.view().unresolvedPaths).toEqual(expect.arrayContaining(['/home/collector/sessions', '/home/collector/archive']))
      const draft = settingsDraft(settings.view())
      draft.model.name = '只修改模型名称'
      await settings.save(draft)
      expect(settings.channels()).toEqual(before)
    } finally { detect.mockRestore() }
  })
  it('非法协议、带密钥的地址、危险 Logo 和重复渠道无法保存', () => {
    for (const baseUrl of ['file:///tmp/model', 'https://user:secret@model.example/v1', 'https://model.example/v1?api_key=secret']) {
      const input = settingsDraft(settings.view()); input.model.baseUrl = baseUrl
      expect(() => settings.save(input)).toThrow()
    }
    const logo = settingsDraft(settings.view()); logo.channels[0].logo = 'data:image/svg+xml;base64,PHNjcmlwdD4='
    expect(() => settings.save(logo)).toThrow()
    const duplicate = settingsDraft(settings.view()); duplicate.channels.push(duplicate.channels[0])
    expect(() => settings.save(duplicate)).toThrow()
  })
})

describe('设置接口', () => {
  async function appForTest() {
    const store = { tasks: async () => [], snapshotTasks: async () => [], sourceCounts: async () => [], dataVersion: async () => 'fixture', recordedDays: async () => [], dailyReports: async () => [], latestRun: async () => null } as unknown as Store
    const sync = new SyncService(store, config, { extract: async () => [], close: async () => {} }, settings)
    const reports = new DailyReportService(store, { generateDailyReport: async () => [], close: async () => {} })
    return { app: await createApp(config, store, sync, reports), sync }
  }
  it('禅道连接测试检查草稿的个人待办权限，不保存草稿或密码，不回传令牌', async () => {
    const { app, sync } = await appForTest(), before = settings.view()
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', token: '私密禅道令牌' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', bugs: [{ id: '10', title: '验证 Bug', status: 'resolved', assignedTo: 'linjt' }], pager: { recTotal: 1, recPerPage: 100, pageID: 1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', tasks: [], pager: { recTotal: 0, recPerPage: 100, pageID: 1 } })))
    vi.stubGlobal('fetch', fetch)
    const payload = { baseUrl: 'https://pm.example/zentao', account: 'linjt', password: '草稿禅道密码' }
    try {
      const result = await app.inject({ method: 'POST', url: '/api/settings/test-zentao', payload })
      expect(result.statusCode).toBe(200)
      expect(result.headers['cache-control']).toBe('no-store')
      expect(result.json()).toMatchObject({ bugs: 1, tasks: 0 })
      expect(result.body).not.toContain(payload.password); expect(result.body).not.toContain('私密禅道令牌')
      expect(settings.view()).toEqual(before); expect(settings.zentaoConnection()).toBeNull()
      fetch.mockReset().mockResolvedValue(new Response('含有密码的私密响应', { status: 403 }))
      const failure = await app.inject({ method: 'POST', url: '/api/settings/test-zentao', payload })
      expect(failure.statusCode).toBe(502); expect(failure.body).toContain('权限'); expect(failure.body).not.toContain('私密响应')
      for (const baseUrl of ['file:///tmp/zentao', 'https://user:secret@pm.example', 'https://pm.example?token=secret', 'https://pm.example/api.php/v1']) {
        expect((await app.inject({ method: 'POST', url: '/api/settings/test-zentao', payload: { ...payload, baseUrl } })).statusCode).toBe(400)
      }
    } finally { await app.close(); await sync.close() }
  })
  it('兼容检测预览脱敏的可见正文，不调用模型或保存草稿，非法字段和目录返回 400', async () => {
    await mkdir(config.CODEX_SESSIONS_DIR)
    const row = { sessionId: 'preview', role: 'user', timestamp: new Date().toISOString(), text: `整理记录 ${config.WORKBENCH_LLM_API_KEY} postgresql://user:test@localhost/db` }
    await writeFile(join(config.CODEX_SESSIONS_DIR, 'preview.jsonl'), JSON.stringify(row) + '\n')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { app, sync } = await appForTest()
    try {
      const before = settings.view()
      const response = await app.inject({ method: 'POST', url: '/api/settings/preview-records', payload: { collector: 'auto', paths: [config.CODEX_SESSIONS_DIR] } })
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toMatchObject({ compatibleFiles: 1, formats: ['通用 JSON / JSONL'], messages: [{ role: 'user', text: expect.stringContaining('整理记录') }] })
      expect(response.body).not.toContain(config.WORKBENCH_LLM_API_KEY); expect(response.body).not.toContain('user:test@')
      expect(settings.view()).toEqual(before); expect(fetch).not.toHaveBeenCalled()
      for (const payload of [
        { collector: 'generic', paths: [] }, { collector: 'auto', paths: ['relative'] }, { collector: 'codex', paths: [config.CODEX_SESSIONS_DIR] },
        { collector: 'generic', paths: [config.CODEX_SESSIONS_DIR], mapping: { ...EMPTY_RECORD_MAPPING, text: 'constructor.name' } },
      ]) expect((await app.inject({ method: 'POST', url: '/api/settings/preview-records', payload })).statusCode).toBe(400)
    } finally { await app.close(); await sync.close() }
  })
  it('目录核对返回文件数量与可读状态，不读取正文，不保存草稿，并拒绝非法路径', async () => {
    await mkdir(config.CODEX_SESSIONS_DIR)
    await writeFile(join(config.CODEX_SESSIONS_DIR, 'session.jsonl'), '不应回传的私密会话内容')
    const { app, sync } = await appForTest()
    try {
      const before = settings.view()
      const response = await app.inject({ method: 'POST', url: '/api/settings/check-paths', payload: { collector: 'codex', paths: [config.CODEX_SESSIONS_DIR, config.CODEX_ARCHIVE_DIR] } })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json().paths.map((entry: { status: string }) => entry.status)).toEqual(['ready', 'missing'])
      expect(response.json().paths[0].recordFiles).toBe(1)
      expect(response.body).not.toContain('不应回传的私密会话内容')
      expect(response.body).not.toContain(config.WORKBENCH_LLM_API_KEY)
      expect(settings.view()).toEqual(before)
      for (const paths of [['relative/path'], ['/tmp/path\ninvalid'], Array(11).fill('/tmp/path')]) {
        expect((await app.inject({ method: 'POST', url: '/api/settings/check-paths', payload: { collector: 'codex', paths } })).statusCode).toBe(400)
      }
    } finally { await app.close(); await sync.close() }
  })
  it('读写接口不回传密钥，响应禁止缓存，并拦截跨站修改', async () => {
    const { app, sync } = await appForTest()
    try {
      const response = await app.inject({ url: '/api/settings' })
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
      const input = settingsDraft(response.json()); input.model.apiKey = '接口测试专用密钥'
      const result = await app.inject({ method: 'PUT', url: '/api/settings', payload: input })
      expect(result.statusCode).toBe(200); expect(result.body).not.toContain(input.model.apiKey)
      const snapshot = await app.inject({ url: '/api/workbench' })
      expect(snapshot.body).not.toContain(input.model.apiKey); expect(snapshot.json().channels).toHaveLength(6)
      expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: { origin: 'https://other.example' }, payload: input })).statusCode).toBe(403)
      expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: input })).statusCode).toBe(409)
    } finally { await app.close(); await sync.close() }
  })
  it('测试草稿模型使用服务端保存的密钥，失败响应不透露上游内容', async () => {
    const { app, sync } = await appForTest()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })))
    vi.stubGlobal('fetch', fetch)
    try {
      const model = { baseUrl: 'https://model.example/v1', name: '测试草稿模型', apiKey: '' }
      const success = await app.inject({ method: 'POST', url: '/api/settings/test-model', payload: model })
      expect(success.statusCode).toBe(200)
      expect(fetch.mock.calls[0][0]).toBe('https://model.example/v1/chat/completions')
      expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${config.WORKBENCH_LLM_API_KEY}`)
      expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(model.name)
      expect(settings.view().model.name).toBe(config.WORKBENCH_LLM_MODEL)
      fetch.mockResolvedValue(new Response('包含私密内容的上游错误', { status: 401 }))
      const failure = await app.inject({ method: 'POST', url: '/api/settings/test-model', payload: model })
      expect(failure.statusCode).toBe(502); expect(failure.body).toContain('密钥无效')
      expect(failure.body).not.toContain('包含私密内容'); expect(failure.body).not.toContain(config.WORKBENCH_LLM_API_KEY)
    } finally { await app.close(); await sync.close() }
  })
  it('多个大 Logo 可以一起保存，首页轮询只传可缓存的图片地址', async () => {
    const { app, sync } = await appForTest()
    try {
      const input = settingsDraft(settings.view())
      const bytes = Buffer.alloc(256 * 1024)
      input.channels.forEach((channel) => { channel.logo = `data:image/png;base64,${bytes.toString('base64')}` })
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(2 * 1024 * 1024)
      expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: input })).statusCode).toBe(200)
      const snapshot = (await app.inject({ url: '/api/workbench' })).json()
      expect(JSON.stringify(snapshot)).not.toContain('data:image')
      const image = await app.inject({ url: snapshot.channels[0].logo })
      expect(image.statusCode).toBe(200); expect(image.headers['content-type']).toBe('image/png')
      expect(image.headers['cache-control']).toContain('immutable'); expect(image.rawPayload).toEqual(bytes)
      expect((await app.inject({ url: '/api/channel-logos/codex?v=过期版本' })).statusCode).toBe(404)
    } finally { await app.close(); await sync.close() }
  })
})
