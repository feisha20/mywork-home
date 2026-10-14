import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checksums, databaseEnv, maintain, verify } from './data-maintenance.mjs'

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'workbench-maintenance-'))
  mkdirSync(join(path, 'settings')); writeFileSync(join(path, 'settings/workbench.json'), '{"fixture":true}')
  writeFileSync(join(path, 'database.dump'), '模拟转储')
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ version: 1, schema: 'workbench', files: checksums(path) }))
  return path
}
test('备份校验拒绝篡改、缺失和符号链接', () => {
  const path = fixture()
  try {
    assert.equal(verify(path).version, 1)
    writeFileSync(join(path, 'database.dump'), '篡改'); assert.throws(() => verify(path), /校验失败/)
    rmSync(join(path, 'database.dump')); assert.throws(() => verify(path), /校验失败/)
    symlinkSync('/etc/hosts', join(path, 'database.dump')); assert.throws(() => verify(path), /符号链接/)
  } finally { rmSync(path, { recursive: true }) }
})
test('数据库连接转换不丢失口令、远程主机和 TLS 参数', () => {
  const env = databaseEnv('postgresql://app:a%40b@host.docker.internal:5433/workbench?sslmode=require')
  assert.equal(env.PGHOST, '127.0.0.1'); assert.equal(env.PGPASSWORD, 'a@b'); assert.equal(env.PGSSLMODE, 'require')
  assert.equal(databaseEnv('postgres://app:p@remote/test').PGHOST, 'remote')
  assert.equal(databaseEnv('postgres://app:p@remote/test', 'override').PGHOST, 'override')
  assert.throws(() => databaseEnv('postgres://app:p@remote/test?options=abc'), /暂不支持/)
})
test('恢复必须明确确认，校验失败不会调用外部程序', () => {
  const path = fixture(), calls = []
  try {
    assert.throws(() => maintain({ mode: 'restore', backup: path }, (...args) => calls.push(args)), /--yes/)
    writeFileSync(join(path, 'database.dump'), '篡改')
    assert.throws(() => maintain({ mode: 'restore', backup: path, yes: true }, (...args) => calls.push(args)), /校验失败/)
    assert.equal(calls.length, 0)
  } finally { rmSync(path, { recursive: true }) }
})
for (const scenario of ['成功备份', '转储失败', '成功恢复', '恢复失败', '原本停机']) test(scenario, () => {
  const path = fixture(), output = mkdtempSync(join(tmpdir(), 'workbench-output-')), calls = []
  const restore = scenario.includes('恢复')
  const runner = (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'docker' && args[0] === 'compose' && args[1] === 'ps') return 'fixture-container'
    if (cmd === 'docker' && args[0] === 'inspect') return JSON.stringify([{ Config: { Env: ['DATABASE_URL=postgres://fixture:secret@localhost/test', 'WORKBENCH_RUNTIME_DIR=/app/.runtime'] }, Image: 'sha256:fixture', State: { Running: scenario !== '原本停机' }, Mounts: [{ Destination: '/app/.runtime', Type: 'volume', Name: 'fixture-volume' }] }])
    if (cmd === 'pg_dump' && args.includes('--file')) {
      if (scenario === '转储失败') throw new Error('模拟转储失败')
      writeFileSync(args[args.indexOf('--file') + 1], '模拟转储')
    }
    if (cmd === 'pg_restore' && args.includes('--clean') && scenario === '恢复失败') throw new Error('模拟恢复失败')
    if (cmd === 'docker' && args[0] === 'cp' && args[1].includes(':/app/.runtime/settings')) {
      mkdirSync(args[2]); writeFileSync(join(args[2], 'workbench.json'), '{"fixture":true}')
    }
    return ''
  }
  try {
    const operation = () => maintain({ mode: restore ? 'restore' : 'backup', backup: restore ? path : undefined, output, yes: true, envFile: join(path, '不存在的环境文件'), lockPath: join(output, '.maintenance.lock') }, runner)
    if (scenario.includes('失败')) assert.throws(operation, /模拟/); else operation()
    const index = flag => calls.findIndex(call => call.includes(flag))
    if (restore) assert.ok(index('--file') < index('--clean'), '必须先备份再恢复')
    const started = calls.some(call => call[0] === 'docker' && call[1] === 'compose' && call[2] === 'start')
    assert.equal(started, !['恢复失败', '原本停机'].includes(scenario))
    assert.equal(existsSync(join(output, '.maintenance.lock')), false)
    if (scenario === '成功恢复') assert.ok(calls.some(call => call[0] === 'docker' && call.includes('none')), '设置恢复使用无网络临时容器')
  } finally { rmSync(path, { recursive: true }); rmSync(output, { recursive: true }) }
})

test('缺少本机客户端时复用已有镜像，口令不进入参数，恢复挂载只读', async () => {
  const { postgresClient } = await import('./data-maintenance.mjs')
  const calls = []
  const client = postgresClient((cmd, args, options) => {
    if (cmd === 'pg_dump') throw new Error('未找到 pg_dump 命令，请安装或加入 PATH')
    calls.push({ cmd, args, options }); return ''
  }, { PGHOST: '127.0.0.1', PGPASSWORD: 'fixture-secret', PGDATABASE: 'fixture' })
  client('pg_dump', ['--file', '/tmp/fixture/database.dump'])
  client('pg_restore', ['--list', '/tmp/fixture/database.dump'])
  assert.ok(calls.every(call => !call.args.join(' ').includes('fixture-secret')))
  assert.ok(calls.some(call => call.args.includes('/tmp/fixture:/backup:ro')))
  assert.ok(calls.some(call => call.args.includes('/tmp/fixture:/backup')))
  assert.equal(calls.at(-1).options.env.PGHOST, 'host.docker.internal')
  assert.ok(calls.at(-1).args.includes('never'))
})
test('错误提示区分命令缺失并隐藏口令', async () => {
  const { run } = await import('./data-maintenance.mjs')
  assert.throws(() => run('workbench-command-does-not-exist', []), /未找到/)
  assert.throws(() => run(process.execPath, ['-e', 'console.error(process.env.PGPASSWORD);process.exit(1)'], { env: { PGPASSWORD: 'fixture-secret' } }), error => error.message.includes('[已隐藏]') && !error.message.includes('fixture-secret'))
})
