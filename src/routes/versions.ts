import { Hono } from 'hono'
import { requireAdmin } from '../middlewares/auth'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

const versions = new Hono<Env>()

// Só administradores: lista as versões cadastradas (mais recente primeiro).
versions.get('/', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, version, description, created_at FROM system_versions ORDER BY id DESC'
  ).all()

  return c.json({ versions: results })
})

// Só administradores podem registrar uma nova versão.
versions.post('/', requireAdmin, async (c) => {
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
