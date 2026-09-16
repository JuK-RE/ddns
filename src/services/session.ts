import { sign, verify } from 'hono/jwt'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'

const SESSION_COOKIE = 'session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 dias

export type SessionPayload = {
  sub: number // id do usuário na tabela `users`
  provider: string
  exp: number
}

type Env = { Bindings: CloudflareBindings }

// Cria a sessão: assina um JWT com o SESSION_SECRET e grava num cookie
// HttpOnly. Não guardamos nada em D1 pra isso — o próprio cookie é a
// sessão (stateless, sem leitura extra no banco a cada request).
//
// `sameSite: 'None'` + `secure: true` porque o front (ddns-ui) fica numa
// origem diferente da API — sem isso o navegador não manda o cookie nas
// chamadas cross-origin. Como SameSite=None exige HTTPS, esse fluxo só
// funciona contra a API implantada (preview/produção); `wrangler dev`
// puro em http não vai manter a sessão entre origens diferentes.
export async function createSession(c: Context<Env>, userId: number, provider: string) {
  const payload: SessionPayload = {
    sub: userId,
    provider,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }

  const token = await sign(payload, c.env.SESSION_SECRET)

  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    maxAge: SESSION_TTL_SECONDS,
  })
}

// Lê e valida o cookie de sessão da request atual. Retorna `null` se não
// houver cookie ou se a assinatura/expiração forem inválidas.
export async function getSession(c: Context<Env>): Promise<SessionPayload | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null

  try {
    const payload = (await verify(token, c.env.SESSION_SECRET)) as SessionPayload
    return payload
  } catch {
    return null
  }
}

export function clearSession(c: Context<Env>) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', sameSite: 'None', secure: true })
}
