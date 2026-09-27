import { Hono } from 'hono'
import type { Context } from 'hono'
import { githubAuth } from '@hono/oauth-providers/github'
import { googleAuth } from '@hono/oauth-providers/google'
import { findOrCreateOAuthUser, getUserById, type OAuthProfile } from '../services/users'
import {
  clearSessionCookie,
  createSessionToken,
  getSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
  setSessionCookie,
} from '../services/session'
import { sendWelcomeEmail, sendNewLoginEmail } from '../services/email'
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

// Base pública das rotas de auth, vista pelo navegador. O front chama a API
// pelo próprio domínio (FRONTEND_URL + /api, via proxy), então é pra lá que
// o provider OAuth tem que voltar — não pro domínio interno do Worker.
function publicAuthUrl(c: Context<Env>, provider: 'github' | 'google') {
  return `${c.env.FRONTEND_URL}/api/auth/${provider}`
}

// Passo final comum aos dois providers: acha/cria o usuário, emite a
// sessão (JWT + linha em `sessions`), grava num cookie httpOnly e manda o
// navegador de volta pro front. Nenhum token vai na URL.
//
// Volta pra /auth (e não pra "/") porque é lá que o front decide pra onde
// levar a pessoa depois do login (ex.: a página do painel que ela tentou
// abrir antes de entrar).
//
// O e-mail é disparado via `waitUntil` — não bloqueia o redirect, e uma
// falha no envio nunca impede o login (ver services/email.ts).
async function completeLogin(c: Context<Env>, provider: string, profile: OAuthProfile) {
  const { user, isNew } = await findOrCreateOAuthUser(c.env.DB, provider, profile)
  const token = await createSessionToken(c, user.id, provider)

  setSessionCookie(c, token)
  c.executionCtx.waitUntil(isNew ? sendWelcomeEmail(c.env, user) : sendNewLoginEmail(c.env, user, provider))

  return c.redirect(`${c.env.FRONTEND_URL}/auth?login=success`)
}

function loginFailed(c: Context<Env>) {
  return c.redirect(`${c.env.FRONTEND_URL}/auth?login=error`)
}

// Sem client_id/secret o @hono/oauth-providers quebra com "Required
// parameters were not found" (texto cru pro usuário). Aqui a gente checa
// antes, registra no log qual segredo falta e devolve o usuário pra tela de
// login com erro amigável.
function missingSecrets(c: Context<Env>, names: (keyof CloudflareBindings)[]) {
  const missing = names.filter((name) => !c.env[name])
  if (missing.length) {
    console.error(`[auth] Segredos ausentes: ${missing.join(', ')}. Configure com \`wrangler secret put\` (produção) ou no .dev.vars (dev).`)
  }
  return missing.length > 0
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
// Callback: como é um OAuth App (`oauthApp: true`), o GitHub ignora o
// redirect_uri e usa o "Authorization callback URL" cadastrado no app — ele
// precisa ser FRONTEND_URL + /api/auth/github.
auth.use('/github', async (c, next) => {
  if (missingSecrets(c, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])) return loginFailed(c)

  return githubAuth({
    client_id: c.env.GITHUB_CLIENT_ID,
    client_secret: c.env.GITHUB_CLIENT_SECRET,
    scope: ['read:user', 'user:email'],
    oauthApp: true,
    redirect_uri: publicAuthUrl(c, 'github'),
  })(c, next)
})

auth.get('/github', async (c) => {
  const githubUser = c.get('user-github' as never) as GithubProfile | undefined

  if (!githubUser) return loginFailed(c)

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
auth.use('/google', async (c, next) => {
  if (missingSecrets(c, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])) return loginFailed(c)

  return googleAuth({
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    scope: ['openid', 'email', 'profile'],
    // Precisa estar cadastrado nas "URIs de redirecionamento autorizadas" do
    // Google Cloud Console: FRONTEND_URL + /api/auth/google.
    redirect_uri: publicAuthUrl(c, 'google'),
  })(c, next)
})

auth.get('/google', async (c) => {
  const googleUser = c.get('user-google' as never) as GoogleProfile | undefined

  if (!googleUser) return loginFailed(c)

  return completeLogin(c, 'google', {
    id: googleUser.id,
    username: googleUser.email ?? googleUser.name ?? googleUser.id,
    email: googleUser.email,
    name: googleUser.name,
    avatar_url: googleUser.picture,
  })
})

// --- Sessão ---------------------------------------------------------------

// "Logout" no dispositivo atual: revoga a sessão desta request e apaga o
// cookie. É POST (e não GET) pra que um link/imagem em outro site não
// consiga deslogar ninguém.
auth.post('/logout', async (c) => {
  const session = await getSession(c)

  if (session) {
    await revokeSession(c.env.DB, session.jti, session.sub)
  }

  clearSessionCookie(c)
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
  const currentId = c.get('sessionId')
  const sessions = await listSessions(c.env.DB, user.id)
  // `current` marca a sessão desta request ("este dispositivo") — o front
  // não tem mais acesso ao token pra descobrir isso sozinho.
  return c.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === currentId })) })
})

// Revoga TODAS as sessões do usuário logado de uma vez (ex.: "sair de
// todos os dispositivos"). Inclui a sessão atual — o token usado nessa
// própria requisição deixa de servir depois dessa chamada.
auth.delete('/sessions', requireAuth, async (c) => {
  const user = c.get('user')
  const revoked = await revokeAllSessions(c.env.DB, user.id)
  clearSessionCookie(c)
  return c.json({ ok: true, revoked })
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

  if (id === c.get('sessionId')) clearSessionCookie(c)

  return c.json({ ok: true, current: id === c.get('sessionId') })
})

export default auth
