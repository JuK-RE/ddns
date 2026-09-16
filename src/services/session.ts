import { sign, verify } from 'hono/jwt'
import type { Context } from 'hono'

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 dias

export type SessionPayload = {
  sub: number // id do usuário na tabela `users`
  provider: string
  exp: number
}

type Env = { Bindings: CloudflareBindings }

// Sem cookie, sem estado no servidor: a sessão é só um JWT assinado que o
// front guarda (localStorage) e manda em todo request via
// `Authorization: Bearer <token>`. Evita de vez a complicação de cookie
// cross-site/SameSite entre domínios diferentes (front e API não
// precisam nem estar no mesmo site), e serve bem clientes que não são
// navegador também (scripts, roteador fazendo o DDNS em si).
export async function createSessionToken(c: Context<Env>, userId: number, provider: string): Promise<string> {
  const payload: SessionPayload = {
    sub: userId,
    provider,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }

  return sign(payload, c.env.SESSION_SECRET, 'HS256')
}

// Lê e valida o token do header Authorization da request atual. Retorna
// `null` se não houver header, não for "Bearer ..." ou a assinatura/
// expiração forem inválidas.
export async function getSession(c: Context<Env>): Promise<SessionPayload | null> {
  const header = c.req.header('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null

  if (!token) return null

  try {
    // A versão instalada do hono (^4.13.8) não tem fallback default pro
    // algoritmo em `verify()` — sem passar 'HS256' explicitamente ela
    // lança "JWT verification requires \"alg\" option to be specified"
    // mesmo com um token válido assinado com HS256.
    return (await verify(token, c.env.SESSION_SECRET, 'HS256')) as SessionPayload
  } catch {
    return null
  }
}
