// Tipos compartilhados entre rotas, middlewares e services.

export type User = {
  id: number
  provider: string
  provider_user_id: string
  username: string | null
  email: string | null
  name: string | null
  avatar_url: string | null
  created_at: string
}

// `Variables` do Hono usadas pelas rotas autenticadas (c.get('user') / c.set('user', ...))
export type AppVariables = {
  user: User
}
