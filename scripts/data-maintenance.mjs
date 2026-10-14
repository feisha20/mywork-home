#!/usr/bin/env node
// 面向现有 Compose 部署；数据库口令仅通过子进程环境传递。
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  if (result.error?.code === 'ENOENT') throw new Error(`未找到 ${command} 命令，请安装或加入 PATH`)
  if (result.error || result.status !== 0) {
    let detail = String(result.stderr || result.error?.message || `退出码 ${result.status}`)
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (value && /PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL/i.test(key)) detail = detail.replaceAll(value, '[已隐藏]')
    }
    detail = detail.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[数据库连接已隐藏]')
    throw new Error(`${command} 执行失败：${detail.trim().slice(0, 2000)}`)
  }
  return result.stdout.trim()
}
export function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix)).sort().flatMap(name => {
    const path = join(prefix, name), stat = lstatSync(join(directory, path))
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('备份中不允许符号链接或特殊文件')
    return stat.isDirectory() ? files(directory, path) : [path]
  })
}
function checksum(path) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = openSync(path, 'r')
  try {
    let count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
export function checksums(directory) {
  return Object.fromEntries(files(directory).filter(path => path !== 'manifest.json').map(path =>
    [path, checksum(join(directory, path))]))
}
export function verify(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('备份路径必须为普通目录')
  // 在读取清单之前排除符号链接。
  files(directory)
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.schema !== 'workbench' || !manifest.files?.['database.dump'] || !manifest.files?.['settings/workbench.json']) throw new Error('备份清单无效或缺少关键数据')
  const actual = checksums(directory)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('备份文件校验失败，拒绝恢复')
  return manifest
}
export function databaseEnv(connection, host) {
  const url = new URL(connection)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1)) throw new Error('数据库连接无效')
  if ([...url.searchParams.keys()].some(key => !['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].includes(key))) throw new Error('数据库 URL 包含暂不支持的连接参数')
  return { ...process.env, PGHOST: host || (url.hostname === 'host.docker.internal' ? '127.0.0.1' : url.hostname),
    PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10',
    ...Object.fromEntries([...url.searchParams].map(([key, value]) => [`PG${key.toUpperCase()}`, value])) }
}
// 优先使用本机客户端；缺少时只使用本机已有镜像，不下载、不构建。
export function postgresClient(execute, pgEnv, image = 'postgres:18') {
  try {
    execute('pg_dump', ['--version']); execute('pg_restore', ['--version'])
    return (command, args) => execute(command, args, { env: pgEnv })
  } catch (error) {
    if (!/未找到 .* 命令/.test(error.message)) throw error
  }
  try { execute('docker', ['image', 'inspect', image]) }
  catch { throw new Error(`未安装 PostgreSQL 客户端，且本机没有 ${image} 镜像；请安装 pg_dump、pg_restore，或指定已有镜像 --client-image 镜像名`) }
  console.log(`未找到本机 PostgreSQL 客户端，使用已有镜像：${image}`)
  const client = (command, args) => {
    const forwarded = { ...pgEnv }
    if (['127.0.0.1', 'localhost', '::1'].includes(forwarded.PGHOST)) forwarded.PGHOST = 'host.docker.internal'
    const dockerArgs = ['run', '--rm', '--pull', 'never', '--add-host', 'host.docker.internal:host-gateway']
    // Docker 从自身环境读取值，口令不会出现在命令行参数中。
    for (const key of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGCONNECT_TIMEOUT', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY']) {
      if (forwarded[key] !== undefined) dockerArgs.push('--env', key)
    }
    if (['PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY'].some(key => forwarded[key])) throw new Error('证书文件连接请使用本机 PostgreSQL 客户端，Docker 客户端不会挂载宿主机证书')
    const mapped = [...args]
    const fileIndex = args.includes('--file') ? args.indexOf('--file') + 1 : args.findIndex(arg => arg.endsWith('/database.dump'))
    if (fileIndex >= 0) {
      const file = resolve(args[fileIndex])
      dockerArgs.push('--volume', `${dirname(file)}:/backup${command === 'pg_restore' ? ':ro' : ''}`)
      mapped[fileIndex] = '/backup/database.dump'
    }
    return execute('docker', [...dockerArgs, '--entrypoint', command, image, ...mapped], { env: forwarded })
  }
  client('pg_dump', ['--version']); client('pg_restore', ['--version'])
  return client
}
export function maintain({ mode, backup, output = join(root, 'backups'), yes = false, dbHost, clientImage, envFile = join(root, '.env'), lockPath = join(root, '.maintenance.lock') }, execute = run) {
  if (!['backup', 'restore'].includes(mode)) throw new Error('操作必须为 backup 或 restore')
  if (mode === 'restore' && (!backup || !yes)) throw new Error('恢复需指定备份目录并添加 --yes 确认覆盖 workbench schema 和设置')
  const source = backup && resolve(backup)
  if (mode === 'restore') verify(source)
  const docker = args => execute('docker', args, { cwd: root })
  const id = docker(['compose', 'ps', '--all', '--quiet', 'workbench'])
  if (!id || id.includes('\n')) throw new Error('需要已创建的单个 workbench 容器，请先完成部署')
  const container = JSON.parse(docker(['inspect', id]))[0]
  const env = Object.fromEntries(container.Config.Env.map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)] }))
  if (env.WORKBENCH_RUNTIME_DIR !== '/app/.runtime') throw new Error('仅支持标准运行目录 /app/.runtime')
  const pgEnv = databaseEnv(env.DATABASE_URL, dbHost)
  if (!container.Mounts.some(mount => mount.Destination === '/app/.runtime' && mount.Type === 'volume')) throw new Error('未找到标准运行数据卷')
  const pg = postgresClient(execute, pgEnv, clientImage)
  if (mode === 'restore') pg('pg_restore', ['--list', join(source, 'database.dump')])
  const outputRoot = resolve(output)
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 })
  const lock = lockPath
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error('已有备份或恢复任务；若上次异常退出，请核实无任务后删除 .maintenance.lock') }
  const wasRunning = container.State.Running
  let mayRestart = mode === 'backup'
  const snapshot = () => {
    const name = `${mode === 'restore' ? 'before-restore' : 'backup'}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
    const partial = join(outputRoot, `.partial-${name}`), destination = join(outputRoot, name)
    mkdirSync(partial, { mode: 0o700 })
    console.log('正在备份数据库及设置…')
    pg('pg_dump', ['--format=custom', '--schema=workbench', '--no-owner', '--no-privileges', '--file', join(partial, 'database.dump')])
    pg('pg_restore', ['--list', join(partial, 'database.dump')])
    docker(['cp', `${id}:/app/.runtime/settings`, join(partial, 'settings')])
    if (!existsSync(join(partial, 'settings/workbench.json'))) throw new Error('缺少工作台设置，备份未完成')
    if (existsSync(envFile)) copyFileSync(envFile, join(partial, 'environment.env'))
    for (const path of files(partial)) chmodSync(join(partial, path), 0o600)
    writeFileSync(join(partial, 'manifest.json'), JSON.stringify({ version: 1, schema: 'workbench', createdAt: new Date().toISOString(), image: container.Image, database: pgEnv.PGDATABASE, files: checksums(partial) }, null, 2), { mode: 0o600 })
    verify(partial)
    renameSync(partial, destination)
    console.log(`备份完成：${destination}`)
    return destination
  }
  try {
    if (wasRunning) {
      console.log('正在停止工作台，等待后台任务退出（最多 120 秒）…')
      docker(['compose', 'stop', '--timeout', '120', 'workbench'])
    }
    snapshot()
    if (mode === 'restore') {
      // 失败后保持停机，避免数据库与设置不一致时启动自动任务。
      pg('pg_restore', ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', pgEnv.PGDATABASE, join(source, 'database.dump')])
      const staging = `.restore-settings-${randomUUID()}`
      docker(['cp', join(source, 'settings'), `${id}:/app/.runtime/${staging}`])
      // 停机容器无法 exec，使用同一镜像的临时容器，仅挂载运行卷，不挂载会话目录。
      const volume = container.Mounts.find(mount => mount.Destination === '/app/.runtime').Name
      docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--volume', `${volume}:/app/.runtime`, '--entrypoint', 'node', container.Image, '-e',
        `const fs=require('fs');const p='/app/.runtime/';fs.rmSync(p+'settings',{recursive:true,force:true});fs.renameSync(p+${JSON.stringify(staging)},p+'settings');function own(p){fs.chownSync(p,1000,1000);if(fs.lstatSync(p).isDirectory())for(const n of fs.readdirSync(p))own(p+'/'+n)}own(p+'settings')`])
      mayRestart = true
      console.log('数据库及设置恢复完成；.env 保留目标环境配置。')
    }
  } finally {
    try {
      if (wasRunning && mayRestart) {
        console.log('正在重新启动工作台…')
        docker(['compose', 'start', 'workbench'])
      }
      else if (wasRunning) console.error('恢复未完成，工作台保持停机；请使用 before-restore 备份恢复后再启动。')
    } finally { rmSync(lock, { recursive: true, force: true }) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, yes: { type: 'boolean' }, 'db-host': { type: 'string' }, 'client-image': { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) console.log('用法：bash scripts/backup.sh [--output 备份根目录] [--db-host 数据库地址] [--client-image 已有PostgreSQL镜像]\n      bash scripts/restore.sh 备份目录 --yes [--output 恢复前备份根目录] [--db-host 地址]')
    else { if (positionals.length > (positionals[0] === 'restore' ? 2 : 1)) throw new Error('参数过多'); maintain({ mode: positionals[0], backup: positionals[1], output: values.output, yes: values.yes, dbHost: values['db-host'], clientImage: values['client-image'] }) }
  } catch (error) { console.error(`操作失败：${error.message}`); process.exitCode = 1 }
}
