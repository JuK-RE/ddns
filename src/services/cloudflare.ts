// Cliente mínimo da API v4 da Cloudflare, só pro que o DDNS precisa:
// criar/atualizar/apagar o registro A de um host.
//
// Regras (ver ADR-003): `proxied: false` sempre (RDP, câmera e portas
// arbitrárias não passam pelo proxy), TTL 60 e um `comment` que permite
// reconciliar os registros com o banco depois.

const CF_API = 'https://api.cloudflare.com/client/v4'

export class CloudflareError extends Error {
  constructor(
    message: string,
    public status: number,
    public codes: number[] = []
  ) {
    super(message)
  }
}

type CfResponse<T> = {
  success: boolean
  errors?: { code: number; message: string }[]
  result: T
}

async function cf<T>(env: CloudflareBindings, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.CF_API_TOKEN) throw new CloudflareError('CF_API_TOKEN não configurado', 500)

  // CF_API_BASE só existe pra testes locais (mock da API); em produção fica vazio.
  const res = await fetch(`${env.CF_API_BASE || CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const data = (await res.json().catch(() => null)) as CfResponse<T> | null

  if (!res.ok || !data?.success) {
    const codes = data?.errors?.map((e) => e.code) ?? []
    const message = data?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new CloudflareError(message, res.status, codes)
  }

  return data.result
}

/** Id da zona na Cloudflare: o da tabela `zones` ou, se vazio, o `CF_ZONE_ID` do Worker. */
export function resolveZoneId(env: CloudflareBindings, zoneCfId: string): string {
  const id = zoneCfId || env.CF_ZONE_ID
  if (!id) throw new CloudflareError('Id da zona da Cloudflare não configurado (CF_ZONE_ID)', 500)
  return id
}

function recordBody(fqdn: string, ip: string, hostId: string) {
  return { type: 'A', name: fqdn, content: ip, ttl: 60, proxied: false, comment: `jukre-ddns host ${hostId}` }
}

/**
 * Garante que `fqdn` aponte pra `ip`. Cria o registro se `recordId` for
 * nulo, atualiza se existir (e recria se ele sumiu na Cloudflare).
 * Devolve o id do registro.
 */
export async function upsertARecord(
  env: CloudflareBindings,
  zoneId: string,
  fqdn: string,
  ip: string,
  hostId: string,
  recordId: string | null
): Promise<string> {
  const body = recordBody(fqdn, ip, hostId)

  if (recordId) {
    try {
      const updated = await cf<{ id: string }>(env, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, body)
      return updated.id
    } catch (err) {
      // Registro apagado por fora → cai pra criação abaixo.
      if (!(err instanceof CloudflareError && err.status === 404)) throw err
    }
  }

  try {
    const created = await cf<{ id: string }>(env, 'POST', `/zones/${zoneId}/dns_records`, body)
    return created.id
  } catch (err) {
    // Já existe um registro A com esse nome (ex.: sobrou de uma exclusão
    // que falhou): adota e atualiza em vez de dar erro.
    if (err instanceof CloudflareError && err.status === 400 && err.codes.some((c) => c === 81057 || c === 81058)) {
      const existing = await cf<{ id: string }[]>(
        env,
        'GET',
        `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`
      )
      if (existing[0]) {
        const updated = await cf<{ id: string }>(env, 'PATCH', `/zones/${zoneId}/dns_records/${existing[0].id}`, body)
        return updated.id
      }
    }
    throw err
  }
}

/** Apaga o registro. Se já não existe (404), considera feito. */
export async function deleteRecord(env: CloudflareBindings, zoneId: string, recordId: string): Promise<void> {
  try {
    await cf(env, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`)
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) return
    throw err
  }
}
