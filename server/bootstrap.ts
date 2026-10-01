import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'dotenv'
import { Pool } from 'pg'

const destination = resolve(process.env.SETUP_ENV_PATH ?? '.env')
const existing = existsSync(destination) ? parse(await readFile(destination)) : {}
const adminUrl = process.env.WORKBENCH_ADMIN_DATABASE_URL
if (!adminUrl) throw new Error('请通过临时环境变量 WORKBENCH_ADMIN_DATABASE_URL 提供初始化连接')
const databaseName = existing.WORKBENCH_DB_NAME ?? process.env.WORKBENCH_DB_NAME ?? 'mywork_home'
const user = existing.WORKBENCH_DB_USER ?? process.env.WORKBENCH_DB_USER ?? 'mywork_home_app'
if (![databaseName, user].every((value) => /^[a-z][a-z0-9_]{2,50}$/.test(value)) || user === 'postgres' || databaseName === 'postgres') throw new Error('专属数据库和用户名无效')
const password = existing.WORKBENCH_DB_PASSWORD ?? randomBytes(32).toString('hex')
const admin = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5000 })
try {
  const role = await admin.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1', [user])
  if (role.rowCount && !existing.WORKBENCH_DB_PASSWORD) throw new Error('专属用户已存在但本机配置缺失；请恢复原配置，不会自动重置密码')
  if (role.rows[0] && (role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole)) throw new Error('已有用户权限过高，请使用新的专属用户名')
  if (!role.rowCount) await admin.query(`CREATE ROLE "${user}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password.replaceAll("'", "''")}'`)
  const database = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [databaseName])
  if (database.rows[0] && database.rows[0].owner !== user) throw new Error('同名数据库由其他用户拥有，请更换专属数据库名')
  if (!database.rowCount) await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${user}" ENCODING 'UTF8'`)
  await admin.query(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`)
  await admin.query(`GRANT CONNECT,TEMPORARY ON DATABASE "${databaseName}" TO "${user}"`)
  const endpoint = new URL(adminUrl)
  endpoint.username = user; endpoint.password = password; endpoint.pathname = `/${databaseName}`
  const probe = new Pool({ connectionString: endpoint.toString(), max: 1, connectionTimeoutMillis: 5000 })
  try { await probe.query('SELECT 1') } finally { await probe.end() }
  const localEndpoint = new URL(endpoint)
  if (localEndpoint.hostname === 'host.docker.internal') localEndpoint.hostname = '127.0.0.1'
  const hostHome = process.env.WORKBENCH_HOST_HOME ?? homedir()
  const values: Record<string, string> = {
    ...existing, DATABASE_URL: localEndpoint.toString(), WORKBENCH_DB_NAME: databaseName, WORKBENCH_DB_USER: user, WORKBENCH_DB_PASSWORD: password,
    WORKBENCH_LLM_API_KEY: process.env.WORKBENCH_LLM_API_KEY || existing.WORKBENCH_LLM_API_KEY || '',
    WORKBENCH_LLM_BASE_URL: existing.WORKBENCH_LLM_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3',
    WORKBENCH_LLM_MODEL: existing.WORKBENCH_LLM_MODEL ?? 'glm-5.3-flash',
    CODEX_SESSIONS_DIR: existing.CODEX_SESSIONS_DIR ?? join(hostHome, '.codex/sessions'),
    CODEX_ARCHIVE_DIR: existing.CODEX_ARCHIVE_DIR ?? join(hostHome, '.codex/archived_sessions'),
    CLAUDE_PROJECTS_DIR: existing.CLAUDE_PROJECTS_DIR ?? join(hostHome, '.claude/projects'),
    SYNC_INTERVAL_MS: existing.SYNC_INTERVAL_MS ?? '600000',
  }
  delete values.WORKBENCH_ADMIN_DATABASE_URL
  const body = '# 工作台本机配置：由初始化程序生成，请勿提交到版本库。\n' + Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n'
  const temporary = `${destination}.tmp.${process.pid}`
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); await chmod(destination, 0o600)
  console.log(`已初始化数据库 ${databaseName} 和专属用户 ${user}；连接凭证已写入本机配置。`)
} catch (error) {
  const message = error instanceof Error && /专属|用户|数据库名|配置/.test(error.message) ? error.message : '初始化失败，请检查数据库管理员连接和权限'
  console.error(message); process.exitCode = 1
} finally { await admin.end() }
