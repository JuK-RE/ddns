// `wrangler types` (script `cf-typegen`) só enxerga bindings declarados no
// wrangler.jsonc (d1_databases, vars, kv, etc). Segredos configurados via
// `wrangler secret put` (ou no arquivo local .dev.vars) nunca aparecem lá,
// então precisamos estender `CloudflareBindings` manualmente aqui.
//
// Sempre que adicionar um novo secret com `wrangler secret put`, declare o
// nome dele também nesta interface.
export {}

declare global {
  interface CloudflareBindings {
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    SESSION_SECRET: string
  }
}
  