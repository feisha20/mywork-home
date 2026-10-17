import pino, { type DestinationStream, type LoggerOptions } from 'pino'
import { redact } from './redact.js'

// 请求体和结构化字段里的凭证只保留占位，避免访问日志带出密钥。
const redactPaths = [
  'req.headers.authorization', 'req.headers.cookie',
  'req.body.password', 'req.body.apiKey', 'req.body.zentaoPassword', 'req.body.model.apiKey', 'req.body.models[*].apiKey',
  'password', 'apiKey', 'zentaoPassword', '*.password', '*.apiKey', '*.zentaoPassword', 'DATABASE_URL', '*.DATABASE_URL',
]

export function loggerOptions(level = process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info')): LoggerOptions {
  return { level, redact: { paths: redactPaths, censor: '[已隐藏凭证]' } }
}

export const logger = pino(loggerOptions())

export function loggedError(error: unknown, secrets: string[] = []) {
  const err = error instanceof Error ? error : new Error('未知错误')
  const code = 'code' in err && err.code != null ? String(err.code) : undefined
  return {
    type: err.name,
    ...(code ? { code } : {}),
    message: redact(err.message, secrets),
    stack: err.stack ? redact(err.stack, secrets) : undefined,
  }
}

export type LogStream = DestinationStream
