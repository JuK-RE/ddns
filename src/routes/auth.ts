import { Hono } from 'hono'
import { githubAuth } from '@hono/oauth-providers/github'
import { findOrCreateGithubUser } from '../services/users'
import { createSession, clearSession, getSession } from '../services/session'
import { getUserById } from '../services/users'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

const auth = new Hono<Env>()

// O middleware do @hono/oauth-providers precisa do client_id/secret na
// hora de montar a requisição — e no Workers isso só existe dentro de uma
// request (via c.env), não no escopo do módulo. Por isso envolvemos numa
// middleware própria que lê c.env e só então chama o githubAuth().
//
// A mesma rota (/auth/github) serve os dois papéis do fluxo OAuth: quando
// acessada sem `?code=`, redireciona pro GitHub; quando o GitHub redireciona
// de volta com o `code`, o middleware troca por um token e popula o contexto.
auth.use('/github', (c, next) => {
  return githubAuth({
    client_id: c.env.GITHUB_CLIENT_ID,
    client_secret: c.env.GITHUB_CLIENT_SECRET,
    scope: ['read:user', 'user:email'],
    oauthApp: true,
  })(c, next)
})

auth.get('/github', async (c) => {
  const githubUser = c.get('user-github' as never) as
    | { id: number | string; login: string; email?: string | null; name?: string | null; avatar_url?: string | null }
    | undefined

  if (!githubUser) {
    return c.json({ error: 'Falha na autenticação com o GitHub' }, 401)
  }

  const user = await findOrCreateGithubUser(c.env.DB, githubUser)
  await createSession(c, user.id, 'github')

  return c.redirect('/')
})

auth.get('/logout', (c) => {
  clearSession(c)
  return c.redirect('/')
})

// Endpoint simples pro frontend checar quem está logado (ou null).
auth.get('/me', async (c) => {
  const session = await getSession(c)

  if (!session) {
    return c.json({ user: null })
  }

  const user = await getUserById(c.env.DB, session.sub)
  return c.json({ user })
})

export default auth
