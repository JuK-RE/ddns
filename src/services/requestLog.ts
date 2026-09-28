import type { Context } from 'hono'
import { toIso } from './hosts'
import type { AppVariables } from '../types'

// Log das chamadas de atualização por host (tabela host_request_log).
// Mantém só as REQUEST_LOG_KEEP mais recentes de cada host.
//
// ⚠️ Nunca gravar token, URL ou headers (além do user-agent).

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

export const REQUEST_LOG_KEEP = 30

export type RequestLogEntry = {
  hostId: string
  source: 'v1' | 'dyndns2'
  result: 'updated' | 'unchanged' | 'disabled' | 'rate_limited' | 'nohost' | 'bad_ip' | 'error'
  status: number
  recordType?: 'A' | 'AAAA' | null
  ip?: string | null
  callerIp?: string | null
  userAgent?: string | null
  message?: string | null
}

/**
 * Grava a chamada e apaga as mais antigas que as 30 últimas do host.
 * Roda depois da resposta (waitUntil): o log nunca atrasa nem derruba a
 * atualização do DNS.
 */
export function logRequest(c: Context<Env>, entry: RequestLogEntry) {
  const db = c.env.DB
  const task = db
    .batch([
      db
        .prepare(
          `INSERT INTO host_request_log (host_id, source, result, status, record_type, ip, caller_ip, user_agent, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          entry.hostId,
          entry.source,
          entry.result,
          entry.status,
          entry.recordType ?? null,
          entry.ip?.slice(0, 64) ?? null,
          entry.callerIp?.slice(0, 64) ?? null,
          entry.userAgent?.slice(0, 200) ?? null,
          entry.message?.slice(0, 200) ?? null
        ),
      db
        .prepare(
          `DELETE FROM host_request_log
           WHERE host_id = ?
             AND id < (SELECT MIN(id) FROM (
               SELECT id FROM host_request_log WHERE host_id = ? ORDER BY id DESC LIMIT ${REQUEST_LOG_KEEP}
             ))`
        )
        .bind(entry.hostId, entry.hostId),
    ])
    .catch((err) => {
      console.error('Falha ao gravar log de requisição:', entry.hostId, err instanceof Error ? err.message : err)
    })

  try {
    c.executionCtx.waitUntil(task)
  } catch {
    // sem executionCtx (testes): a promise segue sozinha
  }
}

// Chamadas recusadas antes de achar o host (limite de 5 min, IP inválido)
// podem vir em rajada de um script mal configurado. Pra não encher o D1,
// esse tipo de linha entra no máximo 1x por minuto por token (flag na Cache API).
const NOISY_EVERY_SECONDS = 60

function noisyKey(tokenHash: string) {
  return new Request(`https://ddns-throttle.internal/log/${tokenHash}`)
}

export async function shouldLogNoisy(c: Context<Env>, tokenHash: string): Promise<boolean> {
  try {
    if (await caches.default.match(noisyKey(tokenHash))) return false
    const put = caches.default
      .put(
        noisyKey(tokenHash),
        new Response('1', { headers: { 'Cache-Control': `max-age=${NOISY_EVERY_SECONDS}` } })
      )
      .catch(() => {})
    try {
      c.executionCtx.waitUntil(put)
    } catch {
      // sem executionCtx
    }
    return true
  } catch {
    return true
  }
}

export async function listRequestLog(db: D1Database, hostId: string) {
  const { results } = await db
    .prepare(
      `SELECT id, source, result, status, record_type, ip, caller_ip, user_agent, message, created_at
       FROM host_request_log WHERE host_id = ? ORDER BY id DESC LIMIT ${REQUEST_LOG_KEEP}`
    )
    .bind(hostId)
    .all<{
      id: number
      source: string
      result: string
      status: number
      record_type: string | null
      ip: string | null
      caller_ip: string | null
      user_agent: string | null
      message: string | null
      created_at: string
    }>()

  return results.map((r) => ({ ...r, created_at: toIso(r.created_at) }))
}
