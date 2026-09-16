import { Hono } from 'hono'
import { requireAuth } from '../middlewares/auth'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

const versions = new Hono<Env>()

// Pública: lista as versões cadastradas (mais recente primeiro).
versions.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, version, description, created_at FROM system_versions ORDER BY id DESC'
  ).all()

  return c.json({ versions: results })
})

// Protegida: só usuário autenticado pode registrar uma nova versão.
versions.post('/', requireAuth, async (c) => {
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

export default versions
