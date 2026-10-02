import { constants, existsSync } from 'node:fs'
import { access, opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { CollectorKind, PathCheckResult, SourcePathCheck, WorkbenchSettings } from '../shared/settings.js'

export interface SourceMount { hostPath: string; containerPath: string; readOnly: boolean }
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))

// 使用当前进程看到的实际挂载，不根据 /records 的名称猜测 Mac 目录，也不访问 Docker socket。
export function parseSourceMounts(mountinfo: string): SourceMount[] {
  const mounts: SourceMount[] = []
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ')
    if (!right) continue
    const fields = left.split(' '), filesystem = right.split(' ')
    if (fields.length < 6 || filesystem.length < 2) continue
    const root = unescapeMount(fields[3]), target = unescapeMount(fields[4]), source = unescapeMount(filesystem[1])
    // Docker Desktop 的宿主机共享盘会标注实际卷名，例如 /run/host_mark/Users。
    const prefix = ['/run/host_mark', '/run/desktop/mnt/host', '/host_mnt'].find((base) => source.startsWith(`${base}/`))
    if (!prefix || !root.startsWith('/') || target === '/') continue
    const hostPath = posix.join(source.slice(prefix.length), root)
    mounts.push({ hostPath, containerPath: target, readOnly: fields[5].split(',').includes('ro') })
  }
  return mounts
}

export class SourcePaths {
  constructor(readonly environment: WorkbenchSettings['pathEnvironment'], private mounts: SourceMount[], private localHome = homedir()) {}
  static async detect() {
    const environment = existsSync('/.dockerenv') ? 'container' : 'local'
    const mountinfo = environment === 'container' ? await readFile('/proc/self/mountinfo', 'utf8').catch(() => '') : ''
    return new SourcePaths(environment, parseSourceMounts(mountinfo))
  }
  resolve(inputPath: string) {
    const homes = [...new Set(this.mounts.map((mount) => mount.hostPath.match(/^((?:\/Users|\/home)\/[^/]+)/)?.[1]).filter((home): home is string => !!home))]
    const home = this.environment === 'container' && homes.length === 1 ? homes[0] : this.localHome
    const path = posix.resolve('/', inputPath.startsWith('~/') ? posix.join(home, inputPath.slice(2)) : inputPath)
    if (this.environment === 'local') return { path, hostPath: path, containerPath: null, readOnly: null, unmounted: false }
    const hostMount = [...this.mounts].sort((a, b) => b.hostPath.length - a.hostPath.length).find((mount) => under(path, mount.hostPath))
    const container = hostMount ? posix.join(hostMount.containerPath, posix.relative(hostMount.hostPath, path)) : path
    const mount = [...this.mounts].sort((a, b) => b.containerPath.length - a.containerPath.length).find((entry) => under(container, entry.containerPath))
    return { path: container, hostPath: mount ? posix.join(mount.hostPath, posix.relative(mount.containerPath, container)) : null,
      containerPath: container, readOnly: mount?.readOnly ?? null,
      unmounted: !mount && (inputPath.startsWith('~/') || /^\/(?:Users|Volumes|home)\//.test(path)) }
  }
  async check(collector: CollectorKind, paths: string[]): Promise<PathCheckResult> {
    return { environment: this.environment, paths: await Promise.all(paths.map((path) => this.checkOne(collector, path))) }
  }
  private async checkOne(collector: CollectorKind, inputPath: string): Promise<SourcePathCheck> {
    const { unmounted, ...location } = this.resolve(inputPath)
    const base = { ...location, inputPath, recordFiles: 0, limited: false }
    if (unmounted) return { ...base, hostPath: location.path, containerPath: null, status: 'unmounted', message: '此本机目录尚未挂载到容器，请先添加只读挂载' }
    try {
      if (!(await stat(location.path)).isDirectory()) return { ...base, status: 'missing', message: '此路径不是目录，请选择会话所在的文件夹' }
      await access(location.path, constants.R_OK | constants.X_OK)
      if (collector === 'none') return { ...base, status: 'empty', message: '目录可读取，该渠道尚未接入记录格式' }
      if (collector === 'zcode') {
        const database = posix.join(location.path, 'db.sqlite')
        const info = await stat(database).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
        if (!info?.isFile()) return { ...base, status: 'empty', message: '目录可读取，但未找到 db.sqlite' }
        await access(database, constants.R_OK)
        return { ...base, status: 'ready', recordFiles: 1, message: '目录可读取，已找到 db.sqlite' }
      }
      const counted = await countRecordFiles(location.path, collector)
      const unit = collector === 'gemini' ? '会话文件' : ' JSONL 文件'
      return { ...base, ...counted, status: counted.recordFiles ? 'ready' : 'empty', message: counted.recordFiles
        ? `目录可读取，已找到${counted.limited ? '至少' : ''} ${counted.recordFiles} 个${unit}`
        : counted.limited ? '目录可读取，本次检查范围内未找到会话文件，请核对目录' : '目录可读取，尚未找到会话文件，请核对目录或先创建会话' }
    } catch (error) {
      return { ...base, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
        message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? '目录不存在或尚未挂载，请核对路径' : '目录或会话文件无法读取，请检查访问权限' }
    }
  }
}

// 只检查目录项和访问权限，沿用采集器的文件位置规则；不读取会话正文，并限制检查耗时。
async function countRecordFiles(root: string, collector: Exclude<CollectorKind, 'none' | 'zcode'>) {
  const stack = [{ path: root, depth: 0 }]
  let recordFiles = 0, entries = 0
  const deadline = Date.now() + 1500
  while (stack.length) {
    const directory = stack.pop()!
    if (collector === 'gemini' && directory.depth === 2 && !directory.path.endsWith('/chats')) continue
    const handle = await opendir(directory.path)
    for await (const entry of handle) {
      if (++entries > 20_000 || recordFiles >= 3000 || Date.now() > deadline) return { recordFiles, limited: true }
      const path = posix.join(directory.path, entry.name)
      if (entry.isDirectory()) stack.push({ path, depth: directory.depth + 1 })
      else if (entry.isFile() && (collector === 'gemini'
        ? directory.depth >= 2 && /\.(?:json|jsonl)$/.test(entry.name) && (directory.depth > 2 || entry.name.startsWith('session-'))
        : entry.name.endsWith('.jsonl'))) {
        await access(path, constants.R_OK)
        recordFiles++
      }
    }
  }
  return { recordFiles, limited: false }
}
