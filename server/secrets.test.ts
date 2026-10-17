import { describe, expect, it } from 'vitest'
import { zentaoIdentity } from '../shared/settings.js'
import { loadConfig } from './config.js'
import { loggedError } from './logger.js'
import { initialContext, normalizeRecord } from './records.js'
import { redact } from './redact.js'
import { runtimeSecrets } from './secrets.js'

const backupKey = 'backup-model-secret-value'
const config = () => ({ ...loadConfig({ DATABASE_URL: 'postgresql://app:database-secret-value@localhost/test', WORKBENCH_LLM_API_KEY: 'primary-model-secret-value' }),
  sourceSecrets: ['zentao-password-secret'],
  models: [
    { id: 'primary', label: '主模型', enabled: true, baseUrl: 'https://primary.example/v1', name: 'primary', apiKey: 'primary-model-secret-value' },
    { id: 'backup', label: '备用模型', enabled: true, baseUrl: 'https://backup.example/v1', name: 'backup', apiKey: backupKey },
  ] })

describe('统一凭据列表', () => {
  it('包含备用模型密钥、数据库密码和采集源密码，无效地址不抛错', () => {
    const secrets = runtimeSecrets(config())
    expect(secrets).toEqual(expect.arrayContaining([backupKey, 'database-secret-value', 'zentao-password-secret', 'primary-model-secret-value']))
    expect(runtimeSecrets({ ...config(), DATABASE_URL: '不是连接地址' })).not.toContain('不是连接地址')
  })
  it('非主模型密钥在入库正文和错误记录中都会被隐藏', () => {
    const secrets = runtimeSecrets(config())
    const row = { timestamp: '2026-10-17T01:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `日志里写了 ${backupKey}` }] } }
    expect(normalizeRecord(row, 'codex', initialContext('session.jsonl', 'codex'), secrets)!.text).not.toContain(backupKey)
    const recorded = redact(`zentao：连接失败 ${backupKey}`, secrets)
    expect(recorded).not.toContain(backupKey)
    expect(loggedError(new Error(`模型返回 ${backupKey}`), secrets).message).not.toContain(backupKey)
  })
})

describe('禅道身份', () => {
  it('去掉地址末尾斜杠后和账号组成同一身份', () => {
    expect(zentaoIdentity({ baseUrl: 'https://pm.example/zentao/', account: 'linjt' })).toEqual({ instance: 'https://pm.example/zentao', account: 'linjt' })
  })
})
