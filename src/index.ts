import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { hasSessionCookie } from './services/session'
import auth from './routes/auth'
import versions from './routes/versions'
import docs from './routes/docs'
import hosts, { zones } from './routes/hosts'
import ddns from './routes/ddns'
import type { AppVariables } from './types'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()

function allowedOrigins(c: { env: CloudflareBindings }) {
  return new Set(['http://localhost:5173', c.env.FRONTEND_URL].filter(Boolean))
}

// CORS: o front do navegador fala com a API pelo próprio domínio (/api, via
// proxy), então em produção nem precisa de CORS. Fica liberado só pras
// origens conhecidas, sem `credentials` — o cookie de sessão nunca é
// aceito numa chamada cross-origin.
app.use('*', async (c, next) => {
  const origins = allowedOrigins(c)

  return cors({
    origin: (origin) => (origins.has(origin) ? origin : undefined),
    allowHeaders: ['Content-Type', 'Authorization'],
  })(c, next)
})

// CSRF: toda request que muda estado (POST/PUT/PATCH/DELETE) autenticada
// por cookie precisa vir de uma origem conhecida. O SameSite=Lax já barra
// quase tudo; isso fecha o resto. Requests com Bearer (CLI) não carregam
// cookie e passam direto.
app.use('*', async (c, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
  if (safe || !hasSessionCookie(c)) return next()

  const origin = c.req.header('origin')
  const fetchSite = c.req.header('sec-fetch-site')
  const trusted = (origin && allowedOrigins(c).has(origin)) || (!origin && fetchSite === 'same-origin')

  if (!trusted) {
    return c.json({ error: 'Origem não permitida' }, 403)
  }

  return next()
})

// Rotas da API. Montadas em dois lugares:
// - "/api/..." → caminho usado pelo front via proxy (ddns.juk.re/api/...);
// - "/..."     → caminho direto, pra CLI/roteadores e compatibilidade.
const api = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()

api.get('/', (c) => {
  return c.json({"message":"Hello Clancy"})
})

api.route('/auth', auth)
api.route('/versions', versions)
api.route('/docs', docs)
api.route('/zones', zones)
api.route('/hosts', hosts)

// Rotas PÚBLICAS de atualização do DDNS (/nic/update, /v1/update/:token, /v1/ip):
// chamadas direto em gateway.juk.re por roteadores/curl/CLI, autenticadas pelo
// token do host. Ficam fora do /api (o proxy da Vercel não passa por elas).
app.route('/', ddns)

app.route('/api', api)
app.route('/', api)

export default app

// Tipo exportado pro cliente RPC do Hono (hc<AppType>(...)), caso um
// front-end venha a consumir essa API com type-safety ponta a ponta.
export type AppType = typeof app
