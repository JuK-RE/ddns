// "Admin" = e-mail listado no secret ADMIN_EMAILS (separado por vírgula).
// Sem o secret, ninguém é admin. Usado pra restringir rotas internas
// (ex.: a página de Versões) e pra o front esconder o que o usuário comum não usa.

export function isAdminEmail(env: CloudflareBindings, email: string | null | undefined): boolean {
  if (!email || !env.ADMIN_EMAILS) return false

  const admins = env.ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  return admins.includes(email.trim().toLowerCase())
}
