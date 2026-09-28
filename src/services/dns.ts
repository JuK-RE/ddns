import { deleteRecord, resolveZoneId, upsertRecord, type RecordType } from './cloudflare'
import { HostError, type HostWithZone } from './hosts'
import { normalizePublicIp } from './ip'

// Edição MANUAL do DNS de um host, pela página "DNS" do painel:
// - liga/desliga o DDNS (com ele desligado, o conector não altera mais o IP);
// - define o IPv4 (A) e/ou o IPv6 (AAAA) do registro na mão, ou remove um deles.
//
// `undefined` = não mexe · `null`/"" = remove o registro · texto = novo IP.

export type ManualDnsPatch = {
  ddns_enabled?: unknown
  ipv4?: unknown
  ipv6?: unknown
}

type Change = {
  record: RecordType
  /** null = remover o registro. */
  ip: string | null
}

function parseChange(record: RecordType, value: unknown, current: string | null): Change | null {
  if (value === undefined) return null

  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return current === null ? null : { record, ip: null }
  }

  const label = record === 'A' ? 'IPv4' : 'IPv6'
  const parsed = typeof value === 'string' ? normalizePublicIp(value) : null
  if (!parsed || parsed.family !== (record === 'A' ? 4 : 6)) {
    throw new HostError(422, 'invalid', `Informe um ${label} público válido.`)
  }

  return parsed.ip === current ? null : { record, ip: parsed.ip }
}

/** O que a edição mudou de fato (pro log do host). */
export type ManualDnsResult = {
  /** true/false = o DDNS foi ligado/desligado agora; null = não mudou. */
  ddns: boolean | null
  changes: { record: RecordType; old: string | null; ip: string | null }[]
}

export async function applyManualDns(
  env: CloudflareBindings,
  host: HostWithZone,
  patch: ManualDnsPatch
): Promise<ManualDnsResult> {
  if (patch.ddns_enabled !== undefined && typeof patch.ddns_enabled !== 'boolean') {
    throw new HostError(422, 'invalid', 'ddns_enabled deve ser verdadeiro ou falso.')
  }

  const changes = [parseChange('A', patch.ipv4, host.last_ipv4), parseChange('AAAA', patch.ipv6, host.last_ipv6)].filter(
    (c): c is Change => c !== null
  )

  const sets: string[] = []
  const binds: (string | number | null)[] = []
  const history: { record: RecordType; old: string | null; ip: string }[] = []

  const ddnsChanged =
    typeof patch.ddns_enabled === 'boolean' && patch.ddns_enabled !== (host.ddns_enabled === 1) ? patch.ddns_enabled : null

  if (typeof patch.ddns_enabled === 'boolean') {
    sets.push('ddns_enabled = ?')
    binds.push(patch.ddns_enabled ? 1 : 0)
  }

  // Cloudflare primeiro: se falhar, o banco continua como estava.
  try {
    for (const { record, ip } of changes) {
      const isA = record === 'A'
      const currentIp = isA ? host.last_ipv4 : host.last_ipv6
      const currentId = isA ? host.cf_record_a_id : host.cf_record_aaaa_id
      const zoneId = resolveZoneId(env, host.zone_cf_id)

      if (ip === null) {
        if (currentId) await deleteRecord(env, zoneId, currentId)
        sets.push(isA ? 'last_ipv4 = NULL, cf_record_a_id = NULL' : 'last_ipv6 = NULL, cf_record_aaaa_id = NULL')
      } else {
        const id = await upsertRecord(env, zoneId, record, host.fqdn, ip, host.id, currentId)
        sets.push(isA ? 'last_ipv4 = ?, cf_record_a_id = ?' : 'last_ipv6 = ?, cf_record_aaaa_id = ?')
        binds.push(ip, id)
        history.push({ record, old: currentIp, ip })
      }
      sets.push("last_change_at = datetime('now')")
    }
  } catch (err) {
    console.error('Falha ao editar DNS na Cloudflare:', host.id, err instanceof Error ? err.message : err)
    throw new HostError(502, 'cloudflare', 'Não foi possível atualizar o DNS na Cloudflare. Tente de novo.')
  }

  const result: ManualDnsResult = {
    ddns: ddnsChanged,
    changes: changes.map(({ record, ip }) => ({ record, old: record === 'A' ? host.last_ipv4 : host.last_ipv6, ip })),
  }

  if (sets.length === 0) return result

  const statements = [env.DB.prepare(`UPDATE hosts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, host.id)]
  for (const h of history) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO host_ip_history (host_id, record_type, old_ip, new_ip, source) VALUES (?, ?, ?, ?, 'manual')`
      ).bind(host.id, h.record, h.old, h.ip)
    )
  }
  await env.DB.batch(statements)
  return result
}
