import { Hono } from 'hono'

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.get('/', (c) => {
  return c.json({"message":"Hello Clancy"})
})

// Lista as versões registradas na tabela de teste (mais recente primeiro)
app.get('/versions', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, version, description, created_at FROM system_versions ORDER BY id DESC'
  ).all()

  return c.json({ versions: results })
})

// Registra uma nova versão do sistema
app.post('/versions', async (c) => {
  const body = await c.req.json<{ version?: string; description?: string }>()

  if (!body.version) {
    return c.json({ error: 'O campo "version" é obrigatório' }, 400)
  }

  const insert = await c.env.DB.prepare(
    'INSERT INTO system_versions (version, description) VALUES (?, ?)'
  )
    .bind(body.version, body.description ?? null)
    .run()

  const created = await c.env.DB.prepare(
    'SELECT id, version, description, created_at FROM system_versions WHERE id = ?'
  )
    .bind(insert.meta.last_row_id)
    .first()

  return c.json({ version: created }, 201)
})

export default app
