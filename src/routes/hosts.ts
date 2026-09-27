import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireAuth } from '../middlewares/auth'
import { deleteRecord, resolveZoneId } from '../services/cloudflare'
import { applyManualDns } from '../services/dns'
import { sendHostCreatedEmail, sendHostDeletedEmail } from '../services/email'
import {
  HostError,
  MAX_HOSTS_PER_USER,
  QUARANTINE_DAYS,
  checkAvailability,
  createHost,
  getHistory,
  getHostForUser,
  getZoneBySuffix,
  listHosts,
  listZones,
  markDeleted,
  regenerateToken,
  serializeHost,
  toIso,
  updateHost,
} from '../services/hosts'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

// Rotas do PAINEL: usadas pelo front (via proxy /api), autenticadas pela
// sessão. Tudo é escopado por usuário: host de outra pessoa dá 404, nunca
// 403, pra não revelar que ele existe.

function fail(c: Context<Env>, err: unknown) {
  if (err instanceof HostError) {
    return c.json({ error: err.message, code: err.code, ...err.extra }, err.status)
  }
  throw err
}

function later(c: Context<Env>, task: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    // sem executionCtx: a promise segue sozinha
  }
}

// ─── /zones ────────────────────────────────────────────────────────────
export const zones = new Hono<Env>()

zones.get('/', requireAuth, async (c) => {
  const list = await listZones(c.env.DB)
  return c.json({ zones: list.map(({ id, suffix, description }) => ({ id, suffix, description })) })
})

// ─── /hosts ────────────────────────────────────────────────────────────
const hosts = new Hono<Env>()

hosts.use('*', requireAuth)

// Disponibilidade do nome (o front chama enquanto a pessoa digita).
// Precisa vir antes de "/:id".
hosts.get('/availability', async (c) => {
  const user = c.get('user')
  const name = (c.req.query('name') ?? '').trim().toLowerCase()
  const zone = await getZoneBySuffix(c.env.DB, c.req.query('zone') ?? '')

  if (!zone) return c.json({ available: false, reason: 'invalid', message: 'Zona inválida.' })

  return c.json(await checkAvailability(c.env.DB, zone.id, name, user.id))
})

hosts.get('/', async (c) => {
  const user = c.get('user')
  const list = await listHosts(c.env.DB, user.id)
  return c.json({ hosts: list.map(serializeHost), limit: MAX_HOSTS_PER_USER, used: list.length })
})

hosts.post('/', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  try {
    const { host, token } = await createHost(c.env.DB, user.id, {
      label: body.label,
      name: body.name,
      zone: body.zone,
      connector: body.connector,
    })

    later(c, sendHostCreatedEmail(c.env, user, host))
    // O token só aparece aqui (e ao regenerar): no banco fica só o hash.
    return c.json({ host: serializeHost(host), token }, 201)
  } catch (err) {
    return fail(c, err)
  }
})

hosts.get('/:id', async (c) => {
  const host = await getHostForUser(c.env.DB, c.get('user').id, c.req.param('id'))
  if (!host) return c.json({ error: 'Host não encontrado' }, 404)
  return c.json({ host: serializeHost(host) })
})

// Edita label e tipo de conexão. O endereço não muda (pra trocar: excluir e criar).
hosts.patch('/:id', async (c) => {
  const host = await getHostForUser(c.env.DB, c.get('user').id, c.req.param('id'))
  if (!host) return c.json({ error: 'Host não encontrado' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  try {
    await updateHost(c.env.DB, host, { label: body.label, connector: body.connector })
  } catch (err) {
    return fail(c, err)
  }

  const updated = await getHostForUser(c.env.DB, c.get('user').id, host.id)
  return c.json({ host: serializeHost(updated ?? host) })
})

// Página "DNS": liga/desliga o DDNS e edita o IPv4/IPv6 do registro na mão.
// Body: { ddns_enabled?: boolean, ipv4?: string | null, ipv6?: string | null }
hosts.patch('/:id/dns', async (c) => {
  const host = await getHostForUser(c.env.DB, c.get('user').id, c.req.param('id'))
  if (!host) return c.json({ error: 'Host não encontrado' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  try {
    await applyManualDns(c.env, host, { ddns_enabled: body.ddns_enabled, ipv4: body.ipv4, ipv6: body.ipv6 })
  } catch (err) {
    return fail(c, err)
  }

  const updated = await getHostForUser(c.env.DB, c.get('user').id, host.id)
  return c.json({ host: serializeHost(updated ?? host) })
})

// Regenera o token: o anterior para de funcionar na hora.
hosts.post('/:id/token', async (c) => {
  const host = await getHostForUser(c.env.DB, c.get('user').id, c.req.param('id'))
  if (!host) return c.json({ error: 'Host não encontrado' }, 404)

  const token = await regenerateToken(c.env.DB, host)
  return c.json({ token, token_prefix: token.slice(0, 10) })
})

hosts.delete('/:id', async (c) => {
  const user = c.get('user')
  const host = await getHostForUser(c.env.DB, user.id, c.req.param('id'))
  if (!host) return c.json({ error: 'Host não encontrado' }, 404)

  // Apaga o registro de DNS na hora. Se a Cloudflare falhar, o host é
  // excluído mesmo assim e fica marcado pra limpeza (o nome só volta a
  // ficar livre quando o registro sumir).
  let cleanupPending = false
  for (const recordId of [host.cf_record_a_id, host.cf_record_aaaa_id]) {
    if (!recordId) continue
    try {
      await deleteRecord(c.env, resolveZoneId(c.env, host.zone_cf_id), recordId)
    } catch (err) {
      cleanupPending = true
      console.error('Falha ao apagar registro na Cloudflare:', host.id, err instanceof Error ? err.message : err)
    }
  }

  await markDeleted(c.env.DB, host, cleanupPending)
  later(c, sendHostDeletedEmail(c.env, user, host))

  const releasesAt = toIso(
    new Date(Date.now() + QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  )
  return c.json({ ok: true, available_at: releasesAt })
})

hosts.get('/:id/history', async (c) => {
  const host = await getHostForUser(c.env.DB, c.get('user').id, c.req.param('id'))
  if (!host) return c.json({ error: 'Host não encontrado' }, 404)

  const requested = Number(c.req.query('limit') ?? 50)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50

  return c.json({ history: await getHistory(c.env.DB, host.id, limit) })
})

export default hosts
