import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planProxyBypass } from './docker-proxy-bypass.mjs'

test('仅为指定域名增加绕过，保留系统代理地址和原有例外，不改系统代理模式', () => {
  const settings = { ProxyHTTPMode: 'system', ContainersProxyHTTPMode: '', ContainersOverrideProxyExclude: 'existing.example' }
  const next = planProxyBypass(settings, `HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n 0 : localhost\n 1 : 10.0.0.0/8`, 'pm.example')
  assert.equal(next.ProxyHTTPMode, 'system')
  assert.equal(next.ContainersOverrideProxyHTTP, 'http://127.0.0.1:7890')
  assert.equal(next.ContainersOverrideProxyHTTPS, 'http://127.0.0.1:7890')
  assert.equal(next.ContainersOverrideProxyExclude, 'existing.example,localhost,10.0.0.0/8,pm.example')
  assert.equal(settings.ContainersProxyHTTPMode, '')
  assert.deepEqual(planProxyBypass(next, '', 'pm.example'), next)
})
test('保留已有手动容器代理，拒绝静默替换PAC或缺失的系统代理', () => {
  const settings = { ContainersProxyHTTPMode: 'manual', ContainersOverrideProxyHTTP: 'http://proxy.example:80', ContainersOverrideProxyExclude: 'localhost' }
  assert.equal(planProxyBypass(settings, '', 'pm.example').ContainersOverrideProxyHTTP, 'http://proxy.example:80')
  assert.throws(() => planProxyBypass({}, 'ProxyAutoConfigEnable : 1', 'pm.example'), /PAC/)
  assert.throws(() => planProxyBypass({}, '', 'pm.example'), /静态/)
})
