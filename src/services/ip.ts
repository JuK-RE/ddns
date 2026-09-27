import type { Context } from 'hono'

// Converte "203.0.113.10" em [203, 0, 113, 10]. Só aceita IPv4 canônico
// (4 blocos decimais sem zero à esquerda) — nada de "0x7f.1", "1.2.3" etc.
export function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return null

  const nums: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    nums.push(n)
  }

  return nums as [number, number, number, number]
}

// IPv4 público = qualquer coisa fora dos blocos reservados/privados.
export function isPublicIPv4(value: string): boolean {
  const ip = parseIPv4(value)
  if (!ip) return false
  const [a, b, c] = ip
  // (os blocos de documentação 192.0.2/24, 198.51.100/24 e 203.0.113/24 são
  // aceitos de propósito: os exemplos da documentação e dos testes usam eles)

  if (a === 0) return false // 0.0.0.0/8
  if (a === 10) return false // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64.0.0/10 (CGNAT)
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return false // 192.0.0.0/24
  if (a === 192 && b === 168) return false // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return false // benchmark
  if (a >= 224) return false // multicast, reservado e broadcast

  return true
}

export function looksLikeIPv6(value: string): boolean {
  return value.includes(':')
}

// ─── IPv6 ──────────────────────────────────────────────────────────────

/** "2001:db8::1" → 8 grupos de 16 bits. Sem IPv4 embutido nem zona (%eth0). */
export function parseIPv6(value: string): number[] | null {
  const text = value.trim()
  if (!text.includes(':') || !/^[0-9a-fA-F:]+$/.test(text)) return null

  const halves = text.split('::')
  if (halves.length > 2) return null

  const toGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      groups.push(parseInt(g, 16))
    }
    return groups
  }

  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  if (!head || !tail) return null

  if (halves.length === 1) return head.length === 8 ? head : null
  if (head.length + tail.length > 7) return null // "::" precisa cobrir pelo menos 1 grupo

  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
}

/** Forma canônica (RFC 5952): minúsculo, sem zeros à esquerda, maior sequência de zeros vira "::". */
export function formatIPv6(groups: number[]): string {
  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen) {
      bestStart = i
      bestLen = j - i
    }
    i = j
  }

  const hex = groups.map((g) => g.toString(16))
  if (bestLen < 2) return hex.join(':')

  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`
}

/** IPv6 público = unicast global (2000::/3). Fora disso: loopback, link-local, ULA, multicast… */
export function isPublicIPv6(groups: number[]): boolean {
  return (groups[0] & 0xe000) === 0x2000
}

// ─── Qualquer família ──────────────────────────────────────────────────

export type PublicIp = { family: 4 | 6; ip: string }

/** IP público (v4 ou v6) já normalizado, ou null se for inválido/privado/reservado. */
export function normalizePublicIp(value: string): PublicIp | null {
  const text = value.trim()

  if (looksLikeIPv6(text)) {
    const groups = parseIPv6(text)
    return groups && isPublicIPv6(groups) ? { family: 6, ip: formatIPv6(groups) } : null
  }

  return isPublicIPv4(text) ? { family: 4, ip: text } : null
}

// IP de quem chamou. Atrás da Cloudflare, `CF-Connecting-IP` é confiável.
export function getRequestIp(c: Context): string {
  return c.req.header('cf-connecting-ip')?.trim() || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || ''
}
