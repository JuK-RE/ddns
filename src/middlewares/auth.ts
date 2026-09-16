import { createMiddleware } from 'hono/factory'
import { getSession } from '../services/session'
import { getUserById } from '../services/users'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

// Middleware pra proteger rotas: exige um cookie de sessão válido e um
// usuário existente em D1. Em caso de sucesso, deixa o usuário disponível
// via `c.get('user')` no handler.
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
  await next()
})
