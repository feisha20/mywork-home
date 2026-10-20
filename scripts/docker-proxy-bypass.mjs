import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// 仅调整容器代理的指定域名绕过，不改变 macOS 或 Docker Desktop 自身的代理模式。
export function planProxyBypass(settings, proxyText, hostname) {
  if (!/^[a-z0-9.-]+$/i.test(hostname) || !hostname.includes('.')) throw new Error('请提供有效的禅道主机名')
  const read = (key) => new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(proxyText)?.[1].trim()
  const systemProxy = (kind) => read(`${kind}Enable`) === '1'
    ? `http://${read(`${kind}Proxy`)}:${read(`${kind}Port`)}` : ''
  const containerMode = settings.ContainersProxyHTTPMode || 'system'
  if (containerMode === 'none' || containerMode === 'noProxy') throw new Error('容器已配置直连，无需增加代理绕过')
  const sameAsHost = ['', 'system'].includes(containerMode)
  if (sameAsHost && ['none', 'noProxy'].includes(settings.ProxyHTTPMode)) throw new Error('Docker主代理已配置直连，无需增加代理绕过')
  const hostManual = settings.ProxyHTTPMode === 'manual'
  const http = sameAsHost ? hostManual ? settings.OverrideProxyHTTP : systemProxy('HTTP') : settings.ContainersOverrideProxyHTTP
  const https = sameAsHost ? hostManual ? settings.OverrideProxyHTTPS : systemProxy('HTTPS') : settings.ContainersOverrideProxyHTTPS
  if (read('ProxyAutoConfigEnable') === '1' || settings.ContainersOverrideProxyPAC || sameAsHost && settings.OverrideProxyPAC) {
    throw new Error('检测到PAC配置，请在PAC内添加指定域名直连；本脚本不替换PAC')
  }
  if (!http && !https) throw new Error('没有找到可保留的静态HTTP/HTTPS代理地址，请在Docker设置中核对')
  const systemExceptions = [...proxyText.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map((match) => match[1].trim())
  const exclusions = [...new Set([...(settings.ContainersOverrideProxyExclude || '').split(','),
    ...(sameAsHost ? hostManual ? (settings.OverrideProxyExclude || '').split(',') : systemExceptions : []), hostname].map((v) => v.trim()).filter(Boolean))]
  return { ...settings, ContainersProxyHTTPMode: 'manual', ContainersOverrideProxyHTTP: http || '',
    ContainersOverrideProxyHTTPS: https || '', ContainersOverrideProxyExclude: exclusions.join(',') }
}

async function main() {
  const hostname = process.argv.find((arg) => arg.startsWith('--host='))?.slice(7)
  if (!hostname) throw new Error('用法：node scripts/docker-proxy-bypass.mjs --host=禅道域名 [--apply]')
  const path = join(homedir(), 'Library/Group Containers/group.com.docker/settings-store.json')
  const original = await readFile(path, 'utf8')
  const settings = JSON.parse(original)
  const proxyText = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' })
  const next = planProxyBypass(settings, proxyText, hostname)
  const keys = ['ContainersProxyHTTPMode', 'ContainersOverrideProxyHTTP', 'ContainersOverrideProxyHTTPS', 'ContainersOverrideProxyExclude']
  const changes = keys.filter((key) => settings[key] !== next[key])
  console.log(JSON.stringify({ 目标域名: hostname, 修改字段: changes, 是否写入: process.argv.includes('--apply') }, null, 2))
  if (!process.argv.includes('--apply') || !changes.length) return
  const backupDir = resolve('.runtime/docker-proxy-backups')
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  const backup = join(backupDir, `settings-${Date.now()}.json`)
  await writeFile(backup, original, { mode: 0o600, flag: 'wx' })
  // 写入前复核，避免覆盖Docker自身刚刚保存的设置。
  if (await readFile(path, 'utf8') !== original) throw new Error('Docker设置已变化，已停止写入，请重新执行')
  await writeFile(path, JSON.stringify(next, null, 2) + '\n')
  console.log('已保存容器代理绕过设置，原配置备份：' + backup)
  console.log('没有重启Docker；实际生效需在维护窗口重新启动后，通过代理日志验证。Docker运行期间可能重新保存设置，重启前请核对。')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
