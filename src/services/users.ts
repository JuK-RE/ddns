import type { User } from '../types'

// Perfil já normalizado a partir do provider (GitHub, Google, ...) —
// cada rota em `routes/auth.ts` mapeia o formato específico do provider
// pra este formato comum antes de chamar findOrCreateOAuthUser().
export type OAuthProfile = {
  id: number | string
  username: string | null
  email?: string | null
  name?: string | null
  avatar_url?: string | null
}

// Busca o usuário pelo (provider, provider_user_id) e cria se ainda não
// existir. Essa é a única forma de "cadastro" no sistema — não existe
// senha, tudo vem de uma conta externa (GitHub, Google, ...).
export async function findOrCreateOAuthUser(db: D1Database, provider: string, profile: OAuthProfile): Promise<User> {
  const providerUserId = String(profile.id)

  const existing = await db
    .prepare('SELECT * FROM users WHERE provider = ? AND provider_user_id = ?')
    .bind(provider, providerUserId)
    .first<User>()

  if (existing) {
    return existing
  }

  const insert = await db
    .prepare(
      `INSERT INTO users (provider, provider_user_id, username, email, name, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      provider,
      providerUserId,
      profile.username,
      profile.email ?? null,
      profile.name ?? null,
      profile.avatar_url ?? null
    )
    .run()

  const created = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(insert.meta.last_row_id)
    .first<User>()

  if (!created) {
    throw new Error('Falha ao criar usuário')
  }

  return created
}

export async function getUserById(db: D1Database, id: number): Promise<User | null> {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>()
  return user ?? null
}
