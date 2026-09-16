import type { User } from '../types'

export type GithubProfile = {
  id: number | string
  login: string
  email?: string | null
  name?: string | null
  avatar_url?: string | null
}

// Busca o usuário pelo (provider, provider_user_id) e cria se ainda não
// existir. Essa é a única forma de "cadastro" no sistema — não existe
// senha, tudo vem da conta externa (GitHub, por enquanto).
export async function findOrCreateGithubUser(db: D1Database, profile: GithubProfile): Promise<User> {
  const providerUserId = String(profile.id)

  const existing = await db
    .prepare('SELECT * FROM users WHERE provider = ? AND provider_user_id = ?')
    .bind('github', providerUserId)
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
      'github',
      providerUserId,
      profile.login,
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
