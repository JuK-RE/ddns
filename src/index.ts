import { Hono } from 'hono'
import { cors } from 'hono/cors'
import auth from './routes/auth'
import versions from './routes/versions'
import type { AppVariables } from './types'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()

// CORS: o front (ddns-ui) roda em outra origem, então precisamos liberar
// explicitamente + `credentials: true`, senão o navegador nem manda o
// cookie de sessão nas chamadas cross-origin. O client_id/secret do OAuth
// só existe dentro da request (c.env), por isso montamos o middleware
// aqui dentro em vez de passar a config direto pro `cors()`.
app.use('*', async (c, next) => {
  const allowedOrigins = new Set(
    ['http://localhost:5173', c.env.FRONTEND_URL].filter(Boolean)
  )

  return cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : undefined),
    credentials: true,
    allowHeaders: ['Content-Type'],
  })(c, next)
})

app.get('/', (c) => {
  return c.json({"message":"Hello Clancy"})
})

app.route('/auth', auth)
app.route('/versions', versions)

export default app

// Tipo exportado pro cliente RPC do Hono (hc<AppType>(...)), caso um
// front-end venha a consumir essa API com type-safety ponta a ponta.
export type AppType = typeof app
