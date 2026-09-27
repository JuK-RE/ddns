import { Hono } from 'hono'
import type { Context } from 'hono'
import { getRequestIp } from '../services/ip'
import { processUpdate, type UpdateOutcome } from '../services/ddns'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

// Rotas PÚBLICAS de atualização. Ficam direto em gateway.juk.re (fora do
// proxy /api da Vercel) e são chamadas por roteadores, curl, ddclient e pela
// CLI — nenhum deles é navegador, então não há CORS. A autenticação é o
// token do host (nunca cookie).
//
// ⚠️ Nada aqui pode logar URL, query ou headers: o token viaja neles.
const ddns = new Hono<Env>()

// Respostas nunca devem ser cacheadas (nem pela Cloudflare nem por proxies).
// Feito por handler, e não com um `use('*')`, porque este app é montado na raiz
// e o middleware valeria pra API inteira.
const noStore = (c: Context<Env>) => c.header('Cache-Control', 'no-store')

// ─── Utilitário: "qual é meu IP?" ──────────────────────────────────────
ddns.get('/v1/ip', (c) => {
  noStore(c)
  return c.text(`${getRequestIp(c)}\n`)
})

// ─── Protocolo simples (curl, MikroTik, scripts) ───────────────────────
function respondV1(c: Context<Env>, out: UpdateOutcome) {
  const asText = c.req.query('format') === 'text'

  const send = (status: 200 | 400 | 401 | 403 | 404 | 429 | 503, body: Record<string, unknown>, line: string) =>
    asText ? c.text(`${line}\n`, status) : c.json(body, status)

  switch (out.kind) {
    case 'updated':
      return send(200, { status: 'updated', hostname: out.hostname, ip: out.ip, type: out.record }, `updated ${out.ip}`)
    case 'unchanged':
      return send(200, { status: 'unchanged', hostname: out.hostname, ip: out.ip, type: out.record }, `unchanged ${out.ip}`)
    case 'disabled':
      return send(
        403,
        { status: 'disabled', hostname: out.hostname, message: 'DDNS desativado para este host no painel.' },
        'disabled'
      )
    case 'rate_limited':
      c.header('Retry-After', String(out.retryAfter))
      return send(429, { status: 'rate_limited', retry_after: out.retryAfter }, 'rate_limited')
    case 'unauthorized':
    case 'nohost':
      return send(401, { status: 'unauthorized' }, 'unauthorized')
    case 'bad_ip':
      return send(400, { status: 'bad_ip', message: out.message }, `bad_ip ${out.message}`)
    case 'error':
      return send(503, { status: 'error' }, 'error')
  }
}

// GET /v1/update/<token>[?myip=1.2.3.4][&format=text]
ddns.get('/v1/update/:token', async (c) => {
  noStore(c)
  const out = await processUpdate(c, { token: c.req.param('token'), myip: c.req.query('myip'), source: 'v1' })
  return respondV1(c, out)
})

// Mesma coisa, com o token no header `Authorization: Bearer <token>`.
ddns.get('/v1/update', async (c) => {
  noStore(c)
  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const out = await processUpdate(c, { token, myip: c.req.query('myip'), source: 'v1' })
  return respondV1(c, out)
})

// ─── dyndns2 (pfSense, OPNsense, UniFi, ddclient) ──────────────────────
// GET /nic/update?hostname=x.ip.juk.re&myip=1.2.3.4
// Authorization: Basic base64("x.ip.juk.re:<token>")
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null
  try {
    const decoded = atob(header.slice('Basic '.length).trim())
    const i = decoded.indexOf(':')
    if (i < 0) return null
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) }
  } catch {
    return null
  }
}

function dyn(c: Context<Env>, status: 200 | 400 | 401 | 429 | 503, body: string) {
  return c.text(body, status)
}

ddns.get('/nic/update', async (c) => {
  noStore(c)
  const header = c.req.header('authorization')
  const basic = parseBasic(header)
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null
  const token = basic?.pass ?? bearer

  if (!token) {
    c.header('WWW-Authenticate', 'Basic realm="JUK.re DDNS"')
    return dyn(c, 401, 'badauth')
  }

  // `hostname` pode vir na query ou (em alguns clientes) só como usuário do Basic.
  const raw = c.req.query('hostname') ?? basic?.user ?? ''
  const hostnames = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)

  if (hostnames.length === 0 || hostnames.some((h) => !HOSTNAME_RE.test(h))) {
    return dyn(c, 200, 'notfqdn')
  }

  const out = await processUpdate(c, { token, myip: c.req.query('myip'), hostnames, source: 'dyndns2' })

  // Um token = um hostname. Se vieram vários, o do token recebe a resposta
  // real e os outros, `nohost`.
  const lineFor = (hostname: string): string => {
    switch (out.kind) {
      case 'updated':
        return hostname.toLowerCase() === out.hostname ? `good ${out.ip}` : 'nohost'
      case 'unchanged':
        return hostname.toLowerCase() === out.hostname ? `nochg ${out.ip}` : 'nohost'
      case 'rate_limited':
        return 'abuse'
      case 'unauthorized':
        return 'badauth'
      case 'nohost':
      case 'disabled':
        // Não existe código dyndns2 pra "host pausado"; `nohost` é o que os clientes tratam como "não atualize".
        return 'nohost'
      case 'bad_ip':
        return 'badip'
      case 'error':
        return '911'
    }
  }

  const body = hostnames.map(lineFor).join('\n')

  switch (out.kind) {
    case 'rate_limited':
      c.header('Retry-After', String(out.retryAfter))
      return dyn(c, 429, body)
    case 'unauthorized':
      return dyn(c, 401, body)
    case 'bad_ip':
      return dyn(c, 400, body)
    case 'error':
      return dyn(c, 503, body)
    default:
      return dyn(c, 200, body)
  }
})

export default ddns
