import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { McpClientView, McpSettingsView } from '../shared/mcp.js'
import { mcpClientSchema } from '../shared/mcp.js'

export class McpError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'INVALID_INPUT') { super(message) }
}
export const mcpHash = (value: string) => createHash('sha256').update(value).digest('hex')
export class McpAuth {
  constructor(private pool: Pool) {}
  async view(endpoint: string): Promise<McpSettingsView> {
    const [config, clients] = await Promise.all([
      this.pool.query('SELECT enabled FROM workbench.mcp_config WHERE id=true'),
      this.pool.query('SELECT id,name,can_write,can_read_evidence,created_at,revoked_at FROM workbench.mcp_clients ORDER BY created_at DESC'),
    ])
    return { enabled: !!config.rows[0]?.enabled, endpoint, clients: clients.rows.map(clientView) }
  }
  async setEnabled(enabled: boolean) { await this.pool.query('UPDATE workbench.mcp_config SET enabled=$1 WHERE id=true', [enabled]) }
  async issue(raw: unknown) {
    const input = mcpClientSchema.parse(raw), token = `workbench_${randomBytes(32).toString('base64url')}`
    const result = await this.pool.query(`INSERT INTO workbench.mcp_clients(id,name,token_hash,can_write,can_read_evidence)
      VALUES($1,$2,$3,$4,$5) RETURNING id,name,can_write,can_read_evidence,created_at,revoked_at`,
      [randomUUID(), input.name, mcpHash(token), input.canWrite, input.canReadEvidence])
    return { client: clientView(result.rows[0]), token }
  }
  async revoke(id: string) {
    await this.pool.query('UPDATE workbench.mcp_clients SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1', [id])
  }
  async authorize(header: string | undefined): Promise<McpClientView> {
    const token = header?.match(/^Bearer (workbench_[A-Za-z0-9_-]{43})$/)?.[1]
    if (!token) throw new McpError('请配置工作台 MCP 令牌', 401, 'UNAUTHORIZED')
    const result = await this.pool.query(`SELECT c.id,c.name,c.can_write,c.can_read_evidence,c.created_at,c.revoked_at
      FROM workbench.mcp_clients c CROSS JOIN workbench.mcp_config cfg
      WHERE cfg.id=true AND cfg.enabled AND c.token_hash=$1 AND c.revoked_at IS NULL`, [mcpHash(token)])
    if (!result.rows[0]) throw new McpError('MCP 已停用，或令牌无效、已撤销', 401, 'UNAUTHORIZED')
    return clientView(result.rows[0])
  }
  async audit(client: McpClientView, tool: string, objectId: string | null, result: string) {
    await this.pool.query('INSERT INTO workbench.mcp_audit(client_id,tool,object_id,result) VALUES($1,$2,$3,$4)', [client.id, tool, objectId, result])
  }
}
function clientView(row: Record<string, any>): McpClientView {
  return { id: row.id, name: row.name, canWrite: row.can_write, canReadEvidence: row.can_read_evidence,
    createdAt: new Date(row.created_at).toISOString(), revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null }
}

// 本机入口同时核对 Host 与 Origin，避免用外部域名访问本机服务。
export function isLocalMcpRequest(host: string | undefined, origin: string | undefined) {
  try {
    const url = new URL(`http://${host}`)
    const local = (name: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(name)
    if (!host || !local(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false
    if (!origin) return true
    const source = new URL(origin)
    return ['http:', 'https:'].includes(source.protocol) && local(source.hostname) && source.host === url.host && !source.username && !source.password
  } catch { return false }
}
