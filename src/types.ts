// Tipos compartilhados entre rotas, middlewares e services.

export type User = {
  id: number
  username: string | null
  email: string | null
  name: string | null
  avatar_url: string | null
  created_at: string
  /** Calculado a partir do secret ADMIN_EMAILS (não existe no banco). */
  is_admin?: boolean
}

// `Variables` do Hono usadas pelas rotas autenticadas (c.get('user') / c.set('user', ...))
export type AppVariables = {
  user: User
  /** `jti` da sessão usada nesta request — marca "este dispositivo" na lista. */
  sessionId: string
}
