import { sign, verify } from 'hono/jwt'
import type { Context } from 'hono'

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

type Env = { Bindings: CloudflareBindings }

// Sem cookie: a sessão é um JWT que o front guarda (localStorage) e manda
// em todo request via `Authorization: Bearer <token>`. Evita a
// complicação de cookie cross-site entre domínios diferentes (front e
// API não precisam estar no mesmo site).
//
// O JWT sozinho não pode ser invalidado antes de expirar — por isso cada
// token carrega um `jti` que corresponde a uma linha na tabela
// `sessions`. getSession() confere a assinatura E se essa linha ainda
// existe (ver revokeSession()/revokeAllSessions(), que apagam a linha em
// vez de só marcar como revogada).
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

// Lê e valida o token do header Authorization da request atual. Retorna
// `null` se não houver header, não for "Bearer ...", a assinatura/
// expiração forem inválidas, ou a sessão correspondente não existir mais
// (revogada — ver revokeSession()/revokeAllSessions() — ou nunca ter
// tido `jti`, caso de tokens emitidos antes dessa migração).
export async function getSession(c: Context<Env>): Promise<SessionPayload | null> {
  const header = c.req.header('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null

  if (!token) return null

  try {
    // A versão instalada do hono (^4.13.8) não tem fallback default pro
    // algoritmo em `verify()` — sem passar 'HS256' explicitamente ela
    // lança "JWT verification requires \"alg\" option to be specified"
    // mesmo com um token válido assinado com HS256.
    const payload = (await verify(token, c.env.SESSION_SECRET, 'HS256')) as SessionPayload

    if (!payload.jti) return null

    const session = await c.env.DB.prepare(
      `SELECT id FROM sessions WHERE id = ? AND expires_at > datetime('now')`
    )
      .bind(payload.jti)
      .first()

    if (!session) return null

    return payload
  } catch {
    return null
  }
}

// Revoga uma sessão específica do usuário (ex.: "sair" no dispositivo
// atual, ou deslogar remotamente uma sessão listada em GET
// /auth/sessions). Apaga a linha de vez — não mantém histórico de
// sessões revogadas. Escopado por `userId` pra um usuário não conseguir
// revogar sessão de outra pessoa mesmo sabendo o id. Retorna `true` se
// alguma linha foi de fato apagada agora.
export async function revokeSession(db: D1Database, sessionId: string, userId: number): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ?`)
    .bind(sessionId, userId)
    .run()

  return (result.meta.changes ?? 0) > 0
}

// Revoga (apaga) TODAS as sessões do usuário de uma vez (ex.: "sair de
// todos os dispositivos", incluindo o dispositivo atual). Retorna
// quantas sessões foram de fato apagadas agora.
export async function revokeAllSessions(db: D1Database, userId: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run()

  return result.meta.changes ?? 0
}

// Lista as sessões do usuário, mais recente primeiro — usado pra montar
// a tela de "dispositivos conectados". Como revogar agora apaga a linha,
// só aparecem sessões ativas ou expiradas (nunca "revogada" — a linha
// já não existe mais nesse caso).
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
