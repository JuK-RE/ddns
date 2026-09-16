import { Hono } from 'hono'
import type { Context } from 'hono'
import { githubAuth } from '@hono/oauth-providers/github'
import { googleAuth } from '@hono/oauth-providers/google'
import { findOrCreateOAuthUser, getUserById, type OAuthProfile } from '../services/users'
import { createSessionToken, getSession, revokeSession, listSessions } from '../services/session'
import { requireAuth } from '../middlewares/auth'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

type GithubProfile = {
  id: number | string
  login: string
  email?: string | null
  name?: string | null
  avatar_url?: string | null
}

type GoogleProfile = {
  id: string
  email?: string | null
  name?: string | null
  picture?: string | null
}

const auth = new Hono<Env>()

// Passo final comum aos dois providers: acha/cria o usuário, emite a
// sessão (JWT + linha em `sessions`) e redireciona pro front levando o
// token no fragmento da URL (nunca é enviado a nenhum servidor, só o JS
// do front consegue ler).
async function completeLogin(c: Context<Env>, provider: string, profile: OAuthProfile) {
  const user = await findOrCreateOAuthUser(c.env.DB, provider, profile)
  const token = await createSessionToken(c, user.id, provider)
  return c.redirect(`${c.env.FRONTEND_URL}#token=${token}`)
}

// --- GitHub -----------------------------------------------------------
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
  const githubUser = c.get('user-github' as never) as GithubProfile | undefined

  if (!githubUser) {
    return c.json({ error: 'Falha na autenticação com o GitHub' }, 401)
  }

  return completeLogin(c, 'github', {
    id: githubUser.id,
    username: githubUser.login,
    email: githubUser.email,
    name: githubUser.name,
    avatar_url: githubUser.avatar_url,
  })
})

// --- Google -------------------------------------------------------------
// Mesmo esquema do GitHub acima: middleware lida com o handshake OAuth,
// a rota GET só cuida de mapear o perfil do Google pro formato comum e
// completar o login.
auth.use('/google', (c, next) => {
  return googleAuth({
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    scope: ['openid', 'email', 'profile'],
  })(c, next)
})

auth.get('/google', async (c) => {
  const googleUser = c.get('user-google' as never) as GoogleProfile | undefined

  if (!googleUser) {
    return c.json({ error: 'Falha na autenticação com o Google' }, 401)
  }

  return completeLogin(c, 'google', {
    id: googleUser.id,
    username: googleUser.email ?? googleUser.name ?? googleUser.id,
    email: googleUser.email,
    name: googleUser.name,
    avatar_url: googleUser.picture,
  })
})

// --- Sessão ---------------------------------------------------------------

// "Logout" no dispositivo atual: revoga a sessão correspondente ao token
// enviado (se houver e ainda for válida). O front descarta o token
// localmente de qualquer forma; isso aqui garante que, se alguém copiar
// esse token antes do descarte, ele já não sirva mais.
auth.get('/logout', async (c) => {
  const session = await getSession(c)

  if (session) {
    await revokeSession(c.env.DB, session.jti, session.sub)
  }

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

// Lista as sessões (ativas e revogadas) do usuário logado — base pra uma
// tela de "dispositivos conectados".
auth.get('/sessions', requireAuth, async (c) => {
  const user = c.get('user')
  const sessions = await listSessions(c.env.DB, user.id)
  return c.json({ sessions })
})

// Revoga remotamente uma sessão específica do usuário logado (ex.:
// deslogar um outro dispositivo/aba a partir daqui). Escopado ao próprio
// usuário — não dá pra revogar sessão de outra conta mesmo sabendo o id.
auth.delete('/sessions/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const revoked = await revokeSession(c.env.DB, id, user.id)

  if (!revoked) {
    return c.json({ error: 'Sessão não encontrada' }, 404)
  }

  return c.json({ ok: true })
})

export default auth
