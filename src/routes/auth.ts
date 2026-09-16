import { Hono } from 'hono'
import { githubAuth } from '@hono/oauth-providers/github'
import { findOrCreateGithubUser } from '../services/users'
import { createSessionToken, getSession } from '../services/session'
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
  const token = await createSessionToken(c, user.id, 'github')

  // Volta pro front (SPA) levando o token no fragmento da URL (#) — o
  // fragmento nunca é enviado a nenhum servidor (nem ao nosso, nem a
  // terceiros), só o JavaScript do front consegue ler. O front extrai o
  // token, guarda e limpa a URL.
  return c.redirect(`${c.env.FRONTEND_URL}#token=${token}`)
})

// Sem estado no servidor — o "logout" é só o front descartar o token que
// guardou. Mantido como rota por simetria e pra abrir espaço, no futuro,
// pra uma lista de revogação se precisar invalidar tokens antes de expirar.
auth.get('/logout', (c) => {
  return c.json({ ok: true })
})

// Endpoint pro front checar quem está logado (ou null) a partir do token
// guardado.
auth.get('/me', async (c) => {
  const session = await getSession(c)

  if (!session) {
    return c.json({ user: null })
  }

  const user = await getUserById(c.env.DB, session.sub)
  return c.json({ user })
})

export default auth
