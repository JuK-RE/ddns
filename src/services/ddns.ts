import type { Context } from 'hono'
import { resolveZoneId, upsertARecord } from './cloudflare'
import { findHostByTokenHash, sha256Hex } from './hosts'
import { getRequestIp, isPublicIPv4, looksLikeIPv6 } from './ip'
import type { AppVariables } from '../types'

// Algoritmo de atualização do IP de um host (ADR-003, §8 do planejamento).
// É chamado pelas duas rotas públicas: /v1/update/:token e /nic/update (dyndns2).
//
// ⚠️ Nunca logar o token nem a URL/headers dessas rotas — o token vai neles.

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

export type UpdateSource = 'v1' | 'dyndns2'

export type UpdateOutcome =
  | { kind: 'updated' | 'unchanged'; hostname: string; ip: string }
  | { kind: 'rate_limited'; retryAfter: number }
  | { kind: 'unauthorized' }
  | { kind: 'nohost' }
  | { kind: 'bad_ip'; message: string }
  | { kind: 'error' }

/** Intervalo mínimo entre duas chamadas com o mesmo IP. */
const MIN_INTERVAL_SECONDS = 300
/** `last_check_at` só é regravado quando está com mais de 1 h (economia de escrita no D1). */
const CHECK_WRITE_EVERY = '-1 hour'

// ─── Intervalo mínimo via Cache API ────────────────────────────────────
// Uma entrada por host (chave = hash do token) com o último IP e a hora. É
// gratuito e não toca no D1. O cache é por data center, o que basta: o
// roteador quase sempre cai no mesmo.
function cacheKey(tokenHash: string) {
  return new Request(`https://ddns-throttle.internal/${tokenHash}`)
}

async function recentCall(tokenHash: string, ip: string): Promise<number | null> {
  try {
    const hit = await caches.default.match(cacheKey(tokenHash))
    if (!hit) return null
    const { ip: cachedIp, at } = (await hit.json()) as { ip: string; at: number }
    if (cachedIp !== ip) return null // IP mudou: mudança legítima, deixa passar
    return Math.max(1, MIN_INTERVAL_SECONDS - Math.floor((Date.now() - at) / 1000))
  } catch {
    return null
  }
}

function rememberCall(c: Context<Env>, tokenHash: string, ip: string) {
  const put = caches.default
    .put(
      cacheKey(tokenHash),
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

export async function processUpdate(
  c: Context<Env>,
  opts: {
    token: string
    /** IP informado pelo cliente (`myip`); sem ele, usa o IP de quem chamou. */
    myip?: string | null
    /** dyndns2: hostnames que o cliente diz estar atualizando (o do token tem que estar entre eles). */
    hostnames?: string[]
    source: UpdateSource
  }
): Promise<UpdateOutcome> {
  const tokenHash = await sha256Hex(opts.token)
  const callerIp = getRequestIp(c)

  // 1. Teto de rajada por token.
  if (c.env.DDNS_UPDATE_LIMITER) {
    const { success } = await c.env.DDNS_UPDATE_LIMITER.limit({ key: tokenHash })
    if (!success) return { kind: 'rate_limited', retryAfter: 60 }
  }

  // 2. Qual IP vamos gravar? `myip` ou o de quem chamou. Só IPv4 público (fase 1).
  const newIp = opts.myip?.trim() || callerIp
  if (looksLikeIPv6(newIp)) {
    return {
      kind: 'bad_ip',
      message: opts.myip
        ? 'Só IPv4 por enquanto (IPv6 chega na fase 2).'
        : 'Você chamou por IPv6. Use IPv4 (curl -4) ou informe o IP com ?myip=.',
    }
  }
  if (!isPublicIPv4(newIp)) {
    return { kind: 'bad_ip', message: 'IP inválido ou privado. Informe um IPv4 público.' }
  }

  // 3. Intervalo mínimo de 5 min com o mesmo IP (sem consultar o D1).
  const wait = await recentCall(tokenHash, newIp)
  if (wait !== null) return { kind: 'rate_limited', retryAfter: wait }

  // 4. Token → host.
  const host = await findHostByTokenHash(c.env.DB, tokenHash)
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

  // 6. Sem mudança: não chama a Cloudflare. Só renova `last_check_at` se
  //    o valor salvo já tem mais de 1 h.
  if (newIp === host.last_ipv4) {
    await c.env.DB.prepare(
      `UPDATE hosts SET last_check_at = datetime('now')
       WHERE id = ? AND (last_check_at IS NULL OR last_check_at < datetime('now', '${CHECK_WRITE_EVERY}'))`
    )
      .bind(host.id)
      .run()

    rememberCall(c, tokenHash, newIp)
    return { kind: 'unchanged', hostname: host.fqdn, ip: newIp }
  }

  // 7. Mudou: atualiza o registro A na Cloudflare. Se falhar, não mexe no banco.
  let recordId: string
  try {
    const zoneId = resolveZoneId(c.env, host.zone_cf_id)
    recordId = await upsertARecord(c.env, zoneId, host.fqdn, newIp, host.id, host.cf_record_a_id)
  } catch (err) {
    console.error('Falha ao atualizar DNS na Cloudflare:', host.id, err instanceof Error ? err.message : err)
    return { kind: 'error' }
  }

  // 8. Grava o novo estado + histórico.
  const userAgent = c.req.header('user-agent')?.slice(0, 200) ?? null
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE hosts
       SET last_ipv4 = ?, cf_record_a_id = ?, last_change_at = datetime('now'),
           last_check_at = datetime('now'), last_user_agent = ?
       WHERE id = ?`
    ).bind(newIp, recordId, userAgent, host.id),
    c.env.DB.prepare(
      `INSERT INTO host_ip_history (host_id, record_type, old_ip, new_ip, source, user_agent)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).bind(host.id, host.last_ipv4, newIp, opts.source, userAgent),
  ])

  rememberCall(c, tokenHash, newIp)
  return { kind: 'updated', hostname: host.fqdn, ip: newIp }
}
