import 'dotenv/config'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { z } from 'zod'

const environment = z.object({
  DATABASE_URL: z.string().min(1, '请配置专属数据库连接 DATABASE_URL'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).default(600_000),
  SYNC_ENABLED: z.enum(['true', 'false']).default('true'),
  WORKBENCH_LLM_API_KEY: z.string().default(''),
  WORKBENCH_LLM_BASE_URL: z.url().default('https://ark.cn-beijing.volces.com/api/coding/v3'),
  WORKBENCH_LLM_MODEL: z.string().default('glm-5.3-flash'),
  CODEX_SESSIONS_DIR: z.string().default(join(homedir(), '.codex/sessions')),
  CODEX_ARCHIVE_DIR: z.string().default(join(homedir(), '.codex/archived_sessions')),
  CLAUDE_PROJECTS_DIR: z.string().default(join(homedir(), '.claude/projects')),
  WORKBUDDY_PROJECTS_DIR: z.string().default(join(homedir(), '.workbuddy/projects')),
  ZCODE_DB_DIR: z.string().default(join(homedir(), '.zcode/cli/db')),
  GEMINI_SESSIONS_DIR: z.string().default(join(homedir(), '.gemini/tmp')),
  WORKBENCH_RUNTIME_DIR: z.string().default(resolve('.runtime')),
  WORKBENCH_BATCH_TIMEOUT_MS: z.coerce.number().int().min(100).default(180_000),
  WORKBENCH_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  STATIC_DIR: z.string().default(resolve('dist')),
})

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.safeParse(env)
  if (!parsed.success) throw new Error(`服务配置无效：${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`)
  const config = parsed.data
  let database: URL
  try { database = new URL(config.DATABASE_URL) } catch { throw new Error('数据库连接地址格式无效') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.password) throw new Error('请配置有效的 PostgreSQL 专属连接及密码')
  if (database.username === 'postgres') throw new Error('运行服务必须使用工作台专属数据库用户')
  return config
}
export type Config = ReturnType<typeof loadConfig>
