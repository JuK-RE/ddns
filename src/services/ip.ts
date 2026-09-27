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

// IP de quem chamou. Atrás da Cloudflare, `CF-Connecting-IP` é confiável.
export function getRequestIp(c: Context): string {
  return c.req.header('cf-connecting-ip')?.trim() || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || ''
}
