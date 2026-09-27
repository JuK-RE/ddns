import { createMiddleware } from 'hono/factory'
import { getSession } from '../services/session'
import { isAdminEmail } from '../services/admin'
import { getUserById } from '../services/users'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

// Middleware pra proteger rotas: exige uma sessão válida (cookie httpOnly
// no navegador ou Bearer em clientes como a CLI) e um usuário existente em
// D1. Em caso de sucesso, deixa o usuário e o id da sessão disponíveis via
// `c.get('user')` / `c.get('sessionId')`.
export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const session = await getSession(c)

  if (!session) {
    return c.json({ error: 'Não autenticado' }, 401)
  }

  const user = await getUserById(c.env.DB, session.sub)

  if (!user) {
    return c.json({ error: 'Não autenticado' }, 401)
  }

  c.set('user', { ...user, is_admin: isAdminEmail(c.env, user.email) })
  c.set('sessionId', session.jti)
  await next()
})

// Igual ao requireAuth, mas só deixa passar administradores (ADMIN_EMAILS).
// Devolve 404 (e não 403) pra não revelar que a rota existe.
export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: 'Não autenticado' }, 401)

  const user = await getUserById(c.env.DB, session.sub)
  if (!user) return c.json({ error: 'Não autenticado' }, 401)

  if (!isAdminEmail(c.env, user.email)) return c.json({ error: 'Não encontrado' }, 404)

  c.set('user', { ...user, is_admin: true })
  c.set('sessionId', session.jti)
  await next()
})
