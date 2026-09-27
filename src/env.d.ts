// `wrangler types` (script `cf-typegen`) só enxerga bindings declarados no
// wrangler.jsonc (d1_databases, vars, kv, etc). Segredos configurados via
// `wrangler secret put` (ou no arquivo local .dev.vars) nunca aparecem lá,
// então precisamos estender `CloudflareBindings` manualmente aqui.
//
// Sempre que adicionar um novo secret com `wrangler secret put`, declare o
// nome dele também nesta interface.
export {}

// Binding de Rate Limiting do Workers (só o que usamos dele).
type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> }

declare global {
  interface CloudflareBindings {
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    SESSION_SECRET: string
    RESEND_API_KEY: string
    RESEND_FROM_EMAIL: string
    // DDNS: token da Cloudflare com Zone → DNS → Edit só na zona juk.re.
    CF_API_TOKEN: string
    // Só pra testes locais: URL alternativa da API da Cloudflare (mock). Em produção, não definir.
    CF_API_BASE?: string
    // Id da zona juk.re na Cloudflare. Usado quando `zones.cf_zone_id` está vazio.
    CF_ZONE_ID: string
    // Bindings de Rate Limiting (declarados em `ratelimits` no wrangler.jsonc).
    // Opcionais no tipo: se o binding não existir (ex.: teste), o limite é ignorado.
    DDNS_UPDATE_LIMITER?: RateLimiter
    DDNS_AUTHFAIL_LIMITER?: RateLimiter
  }
}
