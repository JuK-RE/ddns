import { Hono } from 'hono'
import auth from './routes/auth'
import versions from './routes/versions'
import type { AppVariables } from './types'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: AppVariables }>()

app.get('/', (c) => {
  return c.json({"message":"Hello Clancy"})
})

app.route('/auth', auth)
app.route('/versions', versions)

export default app

// Tipo exportado pro cliente RPC do Hono (hc<AppType>(...)), caso um
// front-end venha a consumir essa API com type-safety ponta a ponta.
export type AppType = typeof app
