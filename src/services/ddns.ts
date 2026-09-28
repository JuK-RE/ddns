import type { Context } from 'hono'
import { resolveZoneId, upsertRecord, type RecordType } from './cloudflare'
import { findHostByTokenHash, sha256Hex, type HostWithZone } from './hosts'
import { getRequestIp, ipFamily, normalizePublicIp } from './ip'
import { logRequest, shouldLogNoisy, type RequestLogEntry } from './requestLog'
import type { AppVariables } from '../types'

// Algoritmo de atualização do IP de um host (ADR-003, §8 do planejamento).
// É chamado pelas duas rotas públicas: /v1/update/:token e /nic/update (dyndns2).
// O IP pode ser IPv4 (registro A) ou IPv6 (registro AAAA): quem decide é a
// família do endereço recebido (`myip` ou o IP de quem chamou).
//
// ⚠️ Nunca logar o token nem a URL/headers dessas rotas — o token vai neles.

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

export type UpdateSource = 'v1' | 'dyndns2'

export type UpdateOutcome =
  | { kind: 'updated' | 'unchanged'; hostname: string; ip: string; record: RecordType }
  | { kind: 'rate_limited'; retryAfter: number }
  | { kind: 'unauthorized' }
  | { kind: 'nohost' }
  /** Host com "DDNS ativo" desligado no painel: a atualização é ignorada. */
  | { kind: 'disabled'; hostname: string }
  | { kind: 'bad_ip'; message: string }
  | { kind: 'error' }

/** Intervalo mínimo entre duas chamadas com o mesmo IP. */
const MIN_INTERVAL_SECONDS = 300
/** `last_check_at` só é regravado quando está com mais de 1 h (economia de escrita no D1). */
const CHECK_WRITE_EVERY = '-1 hour'

// ─── Intervalo mínimo via Cache API ────────────────────────────────────
// Uma entrada por host e por família (chave = hash do token + tipo) com o
// último IP e a hora. É gratuito e não toca no D1. O cache é por data
// center, o que basta: o roteador quase sempre cai no mesmo.
function cacheKey(tokenHash: string, record: RecordType) {
  return new Request(`https://ddns-throttle.internal/${tokenHash}/${record}`)
}

async function recentCall(tokenHash: string, record: RecordType, ip: string): Promise<number | null> {
  try {
    const hit = await caches.default.match(cacheKey(tokenHash, record))
    if (!hit) return null
    const { ip: cachedIp, at } = (await hit.json()) as { ip: string; at: number }
    if (cachedIp !== ip) return null // IP mudou: mudança legítima, deixa passar
    return Math.max(1, MIN_INTERVAL_SECONDS - Math.floor((Date.now() - at) / 1000))
  } catch {
    return null
  }
}

function rememberCall(c: Context<Env>, tokenHash: string, record: RecordType, ip: string) {
  const put = caches.default
    .put(
      cacheKey(tokenHash, record),
      new Response(JSON.stringify({ ip, at: Date.now() }), {
        headers: { 'Cache-Control': `max-age=${MIN_INTERVAL_SECONDS}` },
      })
    )
    .catch(() => {})

  try {
    c.executionCtx.waitUntil(put)
  } catch {
    // sem executionCtx (testes): a promise segue sozinha
  }
}

type UpdateOpts = {
  token: string
  /** IP informado pelo cliente (`myip`, v4 ou v6); sem ele, usa o IP de quem chamou. */
  myip?: string | null
  /** dyndns2: hostnames que o cliente diz estar atualizando (o do token tem que estar entre eles). */
  hostnames?: string[]
  source: UpdateSource
}

/** O que a execução descobriu no caminho (pro log). */
type Trace = {
  host: HostWithZone | null
  ip: string | null
  record: RecordType | null
  /** true = o host já foi buscado pelo token (mesmo que não exista). */
  lookedUp: boolean
}

// Status HTTP de cada resultado, como as rotas respondem (ver routes/ddns.ts).
function statusFor(source: UpdateSource, kind: UpdateOutcome['kind']): number {
  switch (kind) {
    case 'updated':
    case 'unchanged':
      return 200
    case 'disabled':
      return source === 'v1' ? 403 : 200
    case 'nohost':
      return source === 'v1' ? 401 : 200
    case 'unauthorized':
      return 401
    case 'rate_limited':
      return 429
    case 'bad_ip':
      return 400
    case 'error':
      return 503
  }
}

/**
 * Atualiza o IP e registra a chamada no log do host (host_request_log).
 * Token inválido não entra no log: sem host não há onde gravar.
 */
export async function processUpdate(c: Context<Env>, opts: UpdateOpts): Promise<UpdateOutcome> {
  const tokenHash = await sha256Hex(opts.token)
  const trace: Trace = { host: null, ip: null, record: null, lookedUp: false }
  const out = await runUpdate(c, opts, tokenHash, trace)

  if (out.kind === 'unauthorized') return out

  // Recusas que acontecem antes de buscar o host (rajada, limite de 5 min,
  // IP inválido): busca o host só pra registrar, no máx. 1x/min por token.
  if (!trace.lookedUp && (out.kind === 'rate_limited' || out.kind === 'bad_ip')) {
    if (!(await shouldLogNoisy(c, tokenHash))) return out
    trace.host = await findHostByTokenHash(c.env.DB, tokenHash).catch(() => null)
  }
  if (!trace.host) return out

  const entry: RequestLogEntry = {
    hostId: trace.host.id,
    source: opts.source,
    result: out.kind,
    status: statusFor(opts.source, out.kind),
    recordType: trace.record,
    ip: trace.ip ?? opts.myip?.trim() ?? null,
    callerIp: getRequestIp(c) || null,
    userAgent: c.req.header('user-agent') ?? null,
    message:
      out.kind === 'bad_ip'
        ? out.message
        : out.kind === 'rate_limited'
          ? `Tente de novo em ${out.retryAfter} s`
          : out.kind === 'nohost'
            ? 'O hostname informado não é o deste token'
            : null,
  }
  logRequest(c, entry)
  return out
}

async function runUpdate(c: Context<Env>, opts: UpdateOpts, tokenHash: string, trace: Trace): Promise<UpdateOutcome> {
  const callerIp = getRequestIp(c)

  // 1. Teto de rajada por token.
  if (c.env.DDNS_UPDATE_LIMITER) {
    const { success } = await c.env.DDNS_UPDATE_LIMITER.limit({ key: tokenHash })
    if (!success) return { kind: 'rate_limited', retryAfter: 60 }
  }

  // 2. Qual IP vamos gravar? `myip` ou o de quem chamou. Só endereços
  //    públicos; a família define o registro (A ou AAAA).
  //    Roteador atrás de CGNAT/duplo NAT (UniFi/inadyn, pfSense, MikroTik
  //    lendo a WAN) manda o IP privado da WAN em `myip`. Nesse caso usamos o
  //    IP de origem da chamada — desde que seja da mesma família, pra um
  //    `myip` IPv4 privado nunca virar atualização do AAAA.
  const myip = opts.myip?.trim() || ''
  let parsed = normalizePublicIp(myip || callerIp)
  if (!parsed && myip) {
    const family = ipFamily(myip)
    const fromCaller = family ? normalizePublicIp(callerIp) : null
    if (fromCaller && fromCaller.family === family) parsed = fromCaller
  }
  if (!parsed) {
    return {
      kind: 'bad_ip',
      message: opts.myip
        ? 'IP inválido ou privado. Informe um IPv4 ou IPv6 público.'
        : 'Não foi possível usar o IP de origem da chamada. Informe um IP público com ?myip=.',
    }
  }

  const { ip: newIp, family } = parsed
  const record: RecordType = family === 4 ? 'A' : 'AAAA'
  trace.ip = newIp
  trace.record = record

  // 3. Intervalo mínimo de 5 min com o mesmo IP (sem consultar o D1).
  const wait = await recentCall(tokenHash, record, newIp)
  if (wait !== null) return { kind: 'rate_limited', retryAfter: wait }

  // 4. Token → host.
  const host = await findHostByTokenHash(c.env.DB, tokenHash)
  trace.host = host
  trace.lookedUp = true
  if (!host) {
    // Quem fica errando token é limitado por IP.
    if (c.env.DDNS_AUTHFAIL_LIMITER && callerIp) {
      const { success } = await c.env.DDNS_AUTHFAIL_LIMITER.limit({ key: callerIp })
      if (!success) return { kind: 'rate_limited', retryAfter: 60 }
    }
    return { kind: 'unauthorized' }
  }

  // 5. dyndns2: o hostname informado tem que ser o do host do token.
  if (opts.hostnames && !opts.hostnames.some((h) => h.toLowerCase() === host.fqdn)) {
    return { kind: 'nohost' }
  }

  // Renova `last_check_at` só se o valor salvo já tem mais de 1 h.
  const touchCheck = () =>
    c.env.DB.prepare(
      `UPDATE hosts SET last_check_at = datetime('now')
       WHERE id = ? AND (last_check_at IS NULL OR last_check_at < datetime('now', '${CHECK_WRITE_EVERY}'))`
    )
      .bind(host.id)
      .run()

  // 6. DDNS pausado no painel: o conector está vivo (registra o contato),
  //    mas o registro não é tocado.
  if (host.ddns_enabled !== 1) {
    await touchCheck()
    return { kind: 'disabled', hostname: host.fqdn }
  }

  // 7. Sem mudança: não chama a Cloudflare.
  const lastIp = family === 4 ? host.last_ipv4 : host.last_ipv6
  if (newIp === lastIp) {
    await touchCheck()
    rememberCall(c, tokenHash, record, newIp)
    return { kind: 'unchanged', hostname: host.fqdn, ip: newIp, record }
  }

  // 8. Mudou: atualiza o registro na Cloudflare. Se falhar, não mexe no banco.
  let recordId: string
  try {
    const zoneId = resolveZoneId(c.env, host.zone_cf_id)
    const currentId = family === 4 ? host.cf_record_a_id : host.cf_record_aaaa_id
    recordId = await upsertRecord(c.env, zoneId, record, host.fqdn, newIp, host.id, currentId)
  } catch (err) {
    console.error('Falha ao atualizar DNS na Cloudflare:', host.id, err instanceof Error ? err.message : err)
    return { kind: 'error' }
  }

  // 9. Grava o novo estado + histórico.
  const userAgent = c.req.header('user-agent')?.slice(0, 200) ?? null
  const setIp =
    family === 4
      ? `last_ipv4 = ?, cf_record_a_id = ?`
      : `last_ipv6 = ?, cf_record_aaaa_id = ?`

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE hosts
       SET ${setIp}, last_change_at = datetime('now'),
           last_check_at = datetime('now'), last_user_agent = ?
       WHERE id = ?`
    ).bind(newIp, recordId, userAgent, host.id),
    c.env.DB.prepare(
      `INSERT INTO host_ip_history (host_id, record_type, old_ip, new_ip, source, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(host.id, record, lastIp, newIp, opts.source, userAgent),
  ])

  rememberCall(c, tokenHash, record, newIp)
  return { kind: 'updated', hostname: host.fqdn, ip: newIp, record }
}
