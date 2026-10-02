import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSourceMounts, SourcePaths } from './sourcePaths.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'workbench-source-paths-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

describe('实际挂载路径解析', () => {
  it('从当前 Docker Desktop 的只读挂载还原 Mac 目录，忽略容器系统挂载', () => {
    expect(parseSourceMounts([
      '216 188 0:43 /linjt/.codex/sessions /records/codex/sessions ro,nosuid,nodev,relatime - fakeowner /run/host_mark/Users rw,fakeowner',
      '217 188 0:43 /linjt/.codex/archived_sessions /records/codex/archived_sessions ro,nosuid,nodev - fakeowner /run/host_mark/Users rw,fakeowner',
      '1 0 0:1 / / rw - overlay overlay rw',
      '2 1 0:2 / /proc rw - proc proc rw',
      '3 1 0:3 /var/lib/docker/volumes/runtime/_data /app/.runtime rw - ext4 /dev/vda rw',
    ].join('\n'))).toEqual([
      { hostPath: '/Users/linjt/.codex/sessions', containerPath: '/records/codex/sessions', readOnly: true },
      { hostPath: '/Users/linjt/.codex/archived_sessions', containerPath: '/records/codex/archived_sessions', readOnly: true },
    ])
  })
  it('还原挂载信息中的空格和反斜线，可识别共享卷的其他前缀', () => {
    expect(parseSourceMounts(String.raw`7 1 0:2 /Work\040Records/session\134backup /records/with\040space rw - virtiofs /run/desktop/mnt/host/Volumes rw`)).toEqual([
      { hostPath: '/Volumes/Work Records/session\\backup', containerPath: '/records/with space', readOnly: false },
    ])
    expect(parseSourceMounts('7 1 0:2 /linjt/.claude/projects /records/claude ro - virtiofs /host_mnt/Users rw')[0].hostPath).toBe('/Users/linjt/.claude/projects')
    expect(parseSourceMounts('格式无效\n7 1 0:2 /home/test /records ro - ext4 /dev/vda rw')).toEqual([])
  })
  it('目录边界和最长挂载决定对应关系，Mac 输入及 ~/ 可以转换为实际采集路径', () => {
    const paths = new SourcePaths('container', [
      { hostPath: '/Users/linjt/.codex', containerPath: '/records/codex', readOnly: true },
      { hostPath: '/Volumes/Archive', containerPath: '/records/codex/archived_sessions', readOnly: true },
    ], '/root')
    expect(paths.resolve('/Users/linjt/.codex/sessions/2026')).toMatchObject({ path: '/records/codex/sessions/2026', hostPath: '/Users/linjt/.codex/sessions/2026', readOnly: true })
    expect(paths.resolve('~/.codex/sessions')).toMatchObject({ path: '/records/codex/sessions', unmounted: false })
    expect(paths.resolve('/records/codex/archived_sessions')).toMatchObject({ hostPath: '/Volumes/Archive' })
    expect(paths.resolve('/Users/linjt/.codex-other')).toMatchObject({ hostPath: null, unmounted: true })
    expect(paths.resolve('/records/codex-other')).toMatchObject({ hostPath: null, readOnly: null })
  })
})

describe('目录读取与文件检查', () => {
  it('在只读挂载中核对 Mac 目录与 JSONL 文件数量，跳过其他文件和符号链接', async () => {
    await mkdir(join(directory, '2026'))
    await writeFile(join(directory, '2026/session.jsonl'), '测试正文不会被读取')
    await writeFile(join(directory, 'auth.json'), '测试认证不会被读取')
    await symlink(join(directory, '2026'), join(directory, 'link'))
    const paths = new SourcePaths('container', [{ hostPath: '/Users/linjt/.codex/sessions', containerPath: directory, readOnly: true }])
    const result = await paths.check('codex', ['/Users/linjt/.codex/sessions'])
    expect(result.paths[0]).toMatchObject({ inputPath: '/Users/linjt/.codex/sessions', path: directory, hostPath: '/Users/linjt/.codex/sessions',
      containerPath: directory, readOnly: true, status: 'ready', recordFiles: 1, limited: false })
    expect(result.paths[0].message).toContain('1 个 JSONL 文件')
  })
  it('区分空目录、缺失、非目录、未挂载及不明宿主机位置', async () => {
    const local = new SourcePaths('local', [], directory)
    expect((await local.check('claude', [directory])).paths[0]).toMatchObject({ status: 'empty', hostPath: directory, containerPath: null })
    expect((await local.check('codex', [join(directory, 'missing')])).paths[0].status).toBe('missing')
    await writeFile(join(directory, 'file'), '')
    expect((await local.check('codex', [join(directory, 'file')])).paths[0].message).toContain('不是目录')
    const docker = new SourcePaths('container', [])
    expect((await docker.check('codex', ['/Users/linjt/.codex/sessions'])).paths[0]).toMatchObject({ status: 'unmounted', hostPath: '/Users/linjt/.codex/sessions', containerPath: null })
    expect((await docker.check('codex', [directory])).paths[0]).toMatchObject({ status: 'empty', hostPath: null, containerPath: directory, readOnly: null })
  })
  it('Zcode 检查 db.sqlite，Gemini 仅检查项目 chats 下的会话文件', async () => {
    const paths = new SourcePaths('local', [])
    expect((await paths.check('zcode', [directory])).paths[0].status).toBe('empty')
    await writeFile(join(directory, 'db.sqlite'), '测试文件')
    expect((await paths.check('zcode', [directory])).paths[0]).toMatchObject({ status: 'ready', recordFiles: 1 })
    await mkdir(join(directory, 'project/chats/parent'), { recursive: true })
    await mkdir(join(directory, 'project/checkpoints'), { recursive: true })
    for (const path of ['project/chats/session-one.json', 'project/chats/parent/message.jsonl', 'project/chats/config.json', 'project/checkpoints/session-checkpoint.json', 'session-at-root.json']) await writeFile(join(directory, path), '')
    expect((await paths.check('gemini', [directory])).paths[0]).toMatchObject({ status: 'ready', recordFiles: 2 })
  })
  it('超出检查耗时时明确标记为局部检查，避免将未找到当作完整结果', async () => {
    await writeFile(join(directory, 'session.jsonl'), '')
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2000)
    expect((await new SourcePaths('local', []).check('codex', [directory])).paths[0]).toMatchObject({ status: 'empty', recordFiles: 0, limited: true })
  })
  it.skipIf(process.getuid?.() === 0)('会话文件无读取权限时不能显示为可读取', async () => {
    const file = join(directory, 'session.jsonl')
    await writeFile(file, '不可读取的测试文件')
    await chmod(file, 0o000)
    try {
      expect((await new SourcePaths('local', []).check('codex', [directory])).paths[0]).toMatchObject({ status: 'unreadable', recordFiles: 0 })
    } finally { await chmod(file, 0o600) }
  })
})
