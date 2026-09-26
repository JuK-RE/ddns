import { sign, verify } from 'hono/jwt'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import type { AppVariables } from '../types'

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 dias

export type SessionPayload = {
  sub: number // id do usuário na tabela `users`
  provider: string
  jti: string // id da linha em `sessions` — permite revogar essa sessão específica
  exp: number
}

export type SessionInfo = {
  id: string
  provider: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}

// Mesmo Env das rotas (com Variables) — senão o TS acusa Context incompatível.
type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

// ─── Onde a sessão mora ────────────────────────────────────────────────
// Navegador: cookie httpOnly + Secure + SameSite=Lax. O JavaScript do front
// nunca vê o token (nada de localStorage nem de "#token=" na URL), então um
// XSS não consegue roubá-lo. Funciona sem dor de cabeça de cookie
// cross-site porque o front chama a API pelo próprio domínio (/api/...,
// repassado pra este Worker por um proxy — ver README).
//
// Clientes que não são navegador (CLI em Go, roteadores): continuam podendo
// mandar `Authorization: Bearer <token>`.
//
// O JWT sozinho não pode ser invalidado antes de expirar — por isso cada
// token carrega um `jti` que corresponde a uma linha na tabela `sessions`.
// getSession() confere a assinatura E se essa linha ainda existe.

// Em HTTPS usamos o prefixo "__Host-", que obriga Secure + Path=/ e proíbe
// Domain: o cookie fica preso ao host exato do front e não vaza pra outros
// subdomínios. Em http://localhost (dev) o prefixo não é aceito, então cai
// pro nome simples.
const SECURE_COOKIE = '__Host-ddns_session'
const DEV_COOKIE = 'ddns_session'

function isHttps(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto')
  if (forwardedProto) return forwardedProto.split(',')[0].trim() === 'https'
  return new URL(c.req.url).protocol === 'https:'
}

export function setSessionCookie(c: Context, token: string) {
  const secure = isHttps(c)
  setCookie(c, secure ? SECURE_COOKIE : DEV_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export function clearSessionCookie(c: Context) {
  // Apaga as duas variações — não custa nada e evita cookie "órfão" se o
  // ambiente mudou de http pra https ou vice-versa.
  deleteCookie(c, SECURE_COOKIE, { path: '/', secure: true })
  deleteCookie(c, DEV_COOKIE, { path: '/' })
}

/** Token da request atual: cookie de sessão (navegador) ou Bearer (CLI). */
function readToken(c: Context): { token: string; via: 'cookie' | 'bearer' } | null {
  const cookie = getCookie(c, SECURE_COOKIE) ?? getCookie(c, DEV_COOKIE)
  if (cookie) return { token: cookie, via: 'cookie' }

  const header = c.req.header('authorization')
  if (header?.startsWith('Bearer ')) return { token: header.slice('Bearer '.length), via: 'bearer' }

  return null
}

/** true se a request está autenticando por cookie (usado na checagem de CSRF). */
export function hasSessionCookie(c: Context): boolean {
  return Boolean(getCookie(c, SECURE_COOKIE) ?? getCookie(c, DEV_COOKIE))
}

export async function createSessionToken(c: Context<Env>, userId: number, provider: string): Promise<string> {
  const jti = crypto.randomUUID()
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS

  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, provider, expires_at) VALUES (?, ?, ?, datetime(?, 'unixepoch'))`
  )
    .bind(jti, userId, provider, exp)
    .run()

  const payload: SessionPayload = { sub: userId, provider, jti, exp }
  return sign(payload, c.env.SESSION_SECRET, 'HS256')
}

// Lê e valida a sessão da request atual (cookie ou Bearer). Retorna `null`
// se não houver token, a assinatura/expiração forem inválidas, ou a sessão
// correspondente não existir mais (revogada).
export async function getSession(c: Context<Env>): Promise<SessionPayload | null> {
  const found = readToken(c)
  if (!found) return null

  try {
    // A versão instalada do hono não tem fallback default pro algoritmo em
    // `verify()` — sem 'HS256' explícito ela lança erro mesmo com token válido.
    const payload = (await verify(found.token, c.env.SESSION_SECRET, 'HS256')) as SessionPayload

    if (!payload.jti) return null

    const session = await c.env.DB.prepare(`SELECT id FROM sessions WHERE id = ? AND expires_at > datetime('now')`)
      .bind(payload.jti)
      .first()

    if (!session) return null

    return payload
  } catch {
    return null
  }
}

// Revoga uma sessão específica do usuário. Apaga a linha de vez. Escopado por
// `userId` pra ninguém revogar sessão de outra pessoa mesmo sabendo o id.
export async function revokeSession(db: D1Database, sessionId: string, userId: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ?`).bind(sessionId, userId).run()

  return (result.meta.changes ?? 0) > 0
}

// Revoga (apaga) TODAS as sessões do usuário de uma vez.
export async function revokeAllSessions(db: D1Database, userId: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run()

  return result.meta.changes ?? 0
}

// Lista as sessões do usuário, mais recente primeiro.
export async function listSessions(db: D1Database, userId: number): Promise<SessionInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT id, provider, created_at, expires_at, revoked_at
       FROM sessions
       WHERE user_id = ?
       ORDER BY created_at DESC`
    )
    .bind(userId)
    .all<SessionInfo>()

  return results
}
