// Hosts DDNS: validação de nome, zonas, token, quarentena e CRUD no D1.
// Regras completas no ADR-003 e em docs/planejamento-ddns-hosts.md.

export const MAX_HOSTS_PER_USER = 5
export const QUARANTINE_DAYS = 15

export const CONNECTORS = ['http', 'mikrotik', 'pfsense', 'unifi', 'ddclient', 'cli'] as const
export type Connector = (typeof CONNECTORS)[number]
// A CLI em Go só chega na fase 2: por enquanto não dá pra escolher.
const SELECTABLE_CONNECTORS: readonly Connector[] = ['http', 'mikrotik', 'pfsense', 'unifi', 'ddclient']

export type Zone = {
  id: number
  suffix: string
  cf_zone_id: string
  description: string | null
}

export type HostRow = {
  id: string
  user_id: number
  zone_id: number
  label: string
  name: string
  fqdn: string
  connector: Connector
  token_hash: string
  token_prefix: string
  last_ipv4: string | null
  cf_record_a_id: string | null
  last_check_at: string | null
  last_change_at: string | null
  last_user_agent: string | null
  cf_cleanup_pending: number
  created_at: string
  deleted_at: string | null
}

// HostRow + dados da zona (join).
export type HostWithZone = HostRow & { zone_suffix: string; zone_cf_id: string }

export class HostError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 422,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

// ─── Datas ─────────────────────────────────────────────────────────────
// O SQLite guarda 'YYYY-MM-DD HH:MM:SS' em UTC (sem fuso). Na saída da API
// viram ISO 8601 com "Z", que o `new Date()` do front entende direito.
export function toIso(value: string | null): string | null {
  if (!value) return null
  return `${value.replace(' ', 'T')}Z`
}

// ─── Nome ──────────────────────────────────────────────────────────────
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/

export const RESERVED_NAMES = new Set([
  'www', 'api', 'app', 'admin', 'root', 'mail', 'smtp', 'imap', 'pop', 'pop3', 'ftp', 'sftp',
  'ns', 'ns1', 'ns2', 'ns3', 'dns', 'gateway', 'status', 'auth', 'login', 'panel', 'painel',
  'dashboard', 'support', 'suporte', 'help', 'ajuda', 'docs', 'blog', 'cdn', 'static', 'assets',
  'juk', 'jukre', 'jucasoft', 'test', 'teste', 'localhost', 'webmail', 'vpn', 'git',
  'ssh', 'cloudflare', 'billing', 'security', 'abuse', 'postmaster', 'hostmaster',
  'webmaster', 'noreply', 'no-reply', 'ip', 'ddns', 'net', 'home', 'srv', 'cam', 'rdp',
])

/** Devolve o motivo da rejeição ou null se o nome é válido (formato + reservados). */
export function validateName(name: string): { reason: 'invalid' | 'reserved'; message: string } | null {
  if (!NAME_RE.test(name)) {
    return {
      reason: 'invalid',
      message: 'Use de 3 a 63 caracteres: letras minúsculas, números e hífen (sem hífen no começo ou no fim).',
    }
  }
  if (name.startsWith('xn--') || name.slice(2, 4) === '--') {
    return { reason: 'invalid', message: 'Esse formato de nome (punycode) não é permitido.' }
  }
  if (RESERVED_NAMES.has(name)) {
    return { reason: 'reserved', message: 'Esse nome é reservado.' }
  }
  return null
}

export function validateLabel(label: unknown): string {
  const value = typeof label === 'string' ? label.trim() : ''
  if (value.length < 1 || value.length > 60) {
    throw new HostError(422, 'invalid', 'O nome do host deve ter de 1 a 60 caracteres.')
  }
  return value
}

export function validateConnector(connector: unknown): Connector {
  if (typeof connector !== 'string' || !SELECTABLE_CONNECTORS.includes(connector as Connector)) {
    throw new HostError(422, 'invalid', 'Tipo de conexão inválido.')
  }
  return connector as Connector
}

// ─── Token ─────────────────────────────────────────────────────────────
function base64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `jukre_` + 32 bytes aleatórios. O prefixo ajuda scanners de segredo a detectar vazamento. */
export async function generateToken(): Promise<{ token: string; hash: string; prefix: string }> {
  const token = `jukre_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`
  return { token, hash: await sha256Hex(token), prefix: token.slice(0, 10) }
}

// ─── Zonas ─────────────────────────────────────────────────────────────
export async function listZones(db: D1Database): Promise<Zone[]> {
  const { results } = await db
    .prepare('SELECT id, suffix, cf_zone_id, description FROM zones WHERE active = 1 ORDER BY sort_order, suffix')
    .all<Zone>()
  return results
}

export async function getZoneBySuffix(db: D1Database, suffix: string): Promise<Zone | null> {
  return db
    .prepare('SELECT id, suffix, cf_zone_id, description FROM zones WHERE suffix = ? AND active = 1')
    .bind(suffix)
    .first<Zone>()
}

// ─── Disponibilidade ───────────────────────────────────────────────────
export type Availability =
  | { available: true }
  | { available: false; reason: 'invalid' | 'reserved' | 'taken'; message?: string }
  | { available: false; reason: 'quarantine'; available_at: string }

/**
 * Nome livre? Considera hosts ativos, a quarentena de 15 dias (só o dono
 * original pode reusar) e exclusões cujo registro na Cloudflare ainda não
 * foi apagado.
 */
export async function checkAvailability(
  db: D1Database,
  zoneId: number,
  name: string,
  userId: number
): Promise<Availability> {
  const invalid = validateName(name)
  if (invalid) return { available: false, reason: invalid.reason, message: invalid.message }

  const { results } = await db
    .prepare(
      `SELECT user_id, deleted_at, cf_cleanup_pending,
              datetime(deleted_at, '+${QUARANTINE_DAYS} days') AS releases_at
       FROM hosts
       WHERE zone_id = ? AND name = ?
         AND (deleted_at IS NULL
              OR deleted_at > datetime('now', '-${QUARANTINE_DAYS} days')
              OR cf_cleanup_pending = 1)`
    )
    .bind(zoneId, name)
    .all<{ user_id: number; deleted_at: string | null; cf_cleanup_pending: number; releases_at: string | null }>()

  if (results.some((r) => r.deleted_at === null || r.cf_cleanup_pending === 1)) {
    return { available: false, reason: 'taken' }
  }

  const others = results.filter((r) => r.user_id !== userId)
  if (others.length > 0) {
    const releasesAt = others.map((r) => r.releases_at as string).sort().pop() as string
    return { available: false, reason: 'quarantine', available_at: toIso(releasesAt) as string }
  }

  return { available: true }
}

// ─── Serialização ──────────────────────────────────────────────────────
export function serializeHost(h: HostWithZone) {
  return {
    id: h.id,
    label: h.label,
    name: h.name,
    zone: h.zone_suffix,
    fqdn: h.fqdn,
    connector: h.connector,
    token_prefix: h.token_prefix,
    last_ipv4: h.last_ipv4,
    last_check_at: toIso(h.last_check_at),
    last_change_at: toIso(h.last_change_at),
    last_user_agent: h.last_user_agent,
    created_at: toIso(h.created_at),
  }
}

const HOST_SELECT = `SELECT hosts.*, zones.suffix AS zone_suffix, zones.cf_zone_id AS zone_cf_id
                     FROM hosts JOIN zones ON zones.id = hosts.zone_id`

// ─── Consultas ─────────────────────────────────────────────────────────
export async function listHosts(db: D1Database, userId: number): Promise<HostWithZone[]> {
  const { results } = await db
    .prepare(`${HOST_SELECT} WHERE hosts.user_id = ? AND hosts.deleted_at IS NULL ORDER BY hosts.created_at DESC`)
    .bind(userId)
    .all<HostWithZone>()
  return results
}

/** Host ativo do usuário; de outra pessoa (ou inexistente) dá null → 404, nunca 403. */
export async function getHostForUser(db: D1Database, userId: number, id: string): Promise<HostWithZone | null> {
  return db
    .prepare(`${HOST_SELECT} WHERE hosts.id = ? AND hosts.user_id = ? AND hosts.deleted_at IS NULL`)
    .bind(id, userId)
    .first<HostWithZone>()
}

export async function findHostByTokenHash(db: D1Database, tokenHash: string): Promise<HostWithZone | null> {
  return db
    .prepare(`${HOST_SELECT} WHERE hosts.token_hash = ? AND hosts.deleted_at IS NULL`)
    .bind(tokenHash)
    .first<HostWithZone>()
}

export async function countActiveHosts(db: D1Database, userId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM hosts WHERE user_id = ? AND deleted_at IS NULL')
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

// ─── Criação / edição / exclusão ───────────────────────────────────────
export async function createHost(
  db: D1Database,
  userId: number,
  input: { label: unknown; name: unknown; zone: unknown; connector: unknown }
): Promise<{ host: HostWithZone; token: string }> {
  const label = validateLabel(input.label)
  const connector = validateConnector(input.connector)
  const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : ''

  const zone = typeof input.zone === 'string' ? await getZoneBySuffix(db, input.zone) : null
  if (!zone) throw new HostError(422, 'invalid', 'Zona inválida.')

  if ((await countActiveHosts(db, userId)) >= MAX_HOSTS_PER_USER) {
    throw new HostError(403, 'limit_reached', `Você já usa os ${MAX_HOSTS_PER_USER} hosts permitidos na sua conta.`)
  }

  const availability = await checkAvailability(db, zone.id, name, userId)
  if (!availability.available) {
    if (availability.reason === 'invalid' || availability.reason === 'reserved') {
      throw new HostError(422, availability.reason, availability.message ?? 'Nome inválido.')
    }
    const extra = availability.reason === 'quarantine' ? { available_at: availability.available_at } : {}
    throw new HostError(409, availability.reason, 'Esse endereço não está disponível.', extra)
  }

  const id = crypto.randomUUID()
  const fqdn = `${name}.${zone.suffix}`
  const { token, hash, prefix } = await generateToken()

  try {
    await db
      .prepare(
        `INSERT INTO hosts (id, user_id, zone_id, label, name, fqdn, connector, token_hash, token_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, userId, zone.id, label, name, fqdn, connector, hash, prefix)
      .run()
  } catch (err) {
    // Corrida entre duas criações do mesmo nome: o índice único barra a segunda.
    if (String(err).includes('UNIQUE')) throw new HostError(409, 'taken', 'Esse endereço não está disponível.')
    throw err
  }

  const host = await getHostForUser(db, userId, id)
  if (!host) throw new Error('Host criado mas não encontrado')
  return { host, token }
}

export async function updateHost(
  db: D1Database,
  host: HostWithZone,
  patch: { label?: unknown; connector?: unknown }
): Promise<void> {
  const label = patch.label === undefined ? host.label : validateLabel(patch.label)
  const connector = patch.connector === undefined ? host.connector : validateConnector(patch.connector)

  await db.prepare('UPDATE hosts SET label = ?, connector = ? WHERE id = ?').bind(label, connector, host.id).run()
}

/** Gera um token novo; o anterior deixa de funcionar na hora. */
export async function regenerateToken(db: D1Database, host: HostWithZone): Promise<string> {
  const { token, hash, prefix } = await generateToken()
  await db.prepare('UPDATE hosts SET token_hash = ?, token_prefix = ? WHERE id = ?').bind(hash, prefix, host.id).run()
  return token
}

/** Marca como excluído (o nome entra em quarentena). `cleanupPending` = o DNS não pôde ser apagado. */
export async function markDeleted(db: D1Database, host: HostWithZone, cleanupPending: boolean): Promise<void> {
  await db
    .prepare(
      `UPDATE hosts
       SET deleted_at = datetime('now'), cf_cleanup_pending = ?, cf_record_a_id = ?
       WHERE id = ?`
    )
    .bind(cleanupPending ? 1 : 0, cleanupPending ? host.cf_record_a_id : null, host.id)
    .run()
}

export async function getHistory(db: D1Database, hostId: string, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT id, record_type, old_ip, new_ip, source, user_agent, created_at
       FROM host_ip_history WHERE host_id = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(hostId, limit)
    .all<{
      id: number
      record_type: string
      old_ip: string | null
      new_ip: string
      source: string
      user_agent: string | null
      created_at: string
    }>()

  return results.map((r) => ({ ...r, created_at: toIso(r.created_at) }))
}
