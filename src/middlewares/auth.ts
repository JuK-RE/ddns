import { createMiddleware } from 'hono/factory'
import { getSession } from '../services/session'
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

  c.set('user', user)
  c.set('sessionId', session.jti)
  await next()
})
