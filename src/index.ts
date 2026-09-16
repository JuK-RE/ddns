import { Hono } from 'hono'
import { cors } from 'hono/cors'
import auth from './routes/auth'
import versions from './routes/versions'
import docs from './routes/docs'
import type { AppVariables } from './types'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()

// CORS: o front (ddns-ui) roda em outra origem. Como a sessão agora é um
// token Bearer (sem cookie), não precisamos de `credentials: true` nem
// nos preocupar com SameSite — só liberar a origem e o header
// `Authorization` pro preflight passar.
app.use('*', async (c, next) => {
  const allowedOrigins = new Set(
    ['http://localhost:5173', c.env.FRONTEND_URL].filter(Boolean)
  )

  return cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : undefined),
    allowHeaders: ['Content-Type', 'Authorization'],
  })(c, next)
})

app.get('/', (c) => {
  return c.json({"message":"Hello Clancy"})
})

app.route('/auth', auth)
app.route('/versions', versions)
app.route('/docs', docs)

export default app

// Tipo exportado pro cliente RPC do Hono (hc<AppType>(...)), caso um
// front-end venha a consumir essa API com type-safety ponta a ponta.
export type AppType = typeof app
