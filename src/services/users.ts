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

export type FindOrCreateResult = {
  user: User
  // true só quando o USUÁRIO (não só a identidade) acabou de ser criado
  // agora — usado em routes/auth.ts pra decidir entre o e-mail de
  // boas-vindas e o de novo login. Logar com um segundo provider numa
  // conta que já existia conta como isNew: false.
  isNew: boolean
}

async function findUserByIdentity(db: D1Database, provider: string, providerUserId: string): Promise<User | null> {
  const user = await db
    .prepare(
      `SELECT users.* FROM users
       JOIN user_identities ON user_identities.user_id = users.id
       WHERE user_identities.provider = ? AND user_identities.provider_user_id = ?`
    )
    .bind(provider, providerUserId)
    .first<User>()

  return user ?? null
}

async function linkIdentity(db: D1Database, userId: number, provider: string, providerUserId: string): Promise<void> {
  await db
    .prepare('INSERT INTO user_identities (user_id, provider, provider_user_id) VALUES (?, ?, ?)')
    .bind(userId, provider, providerUserId)
    .run()
}

// A foto de perfil sempre reflete o que o provider manda no login mais
// recente — a API tem preferência sobre o que já estava salvo (evita
// ficar preso numa foto antiga, ou numa foto padrão gerada antes do
// provider mandar uma de verdade). Só grava quando vem algo novo e
// diferente, pra não bater no banco à toa em todo login.
async function refreshAvatar(db: D1Database, user: User, profile: OAuthProfile): Promise<User> {
  if (!profile.avatar_url || profile.avatar_url === user.avatar_url) {
    return user
  }

  await db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(profile.avatar_url, user.id).run()

  return { ...user, avatar_url: profile.avatar_url }
}

// Acha o usuário dono dessa identidade (provider, provider_user_id) e
// cria usuário + identidade se for a primeira vez que essa combinação
// aparece. Essa é a única forma de "cadastro" no sistema — não existe
// senha, tudo vem de uma conta externa (GitHub, Google, ...).
//
// Um usuário pode ter várias identidades (ex.: mesma pessoa entrando
// pelo GitHub e pelo Google): se o e-mail do provider bate com o de um
// usuário já existente, a nova identidade é VINCULADA a ele em vez de
// criar um segundo usuário pra mesma pessoa.
export async function findOrCreateOAuthUser(
  db: D1Database,
  provider: string,
  profile: OAuthProfile
): Promise<FindOrCreateResult> {
  const providerUserId = String(profile.id)

  const existing = await findUserByIdentity(db, provider, providerUserId)
  if (existing) {
    const refreshed = await refreshAvatar(db, existing, profile)
    return { user: refreshed, isNew: false }
  }

  if (profile.email) {
    const existingByEmail = await db
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(profile.email)
      .first<User>()

    if (existingByEmail) {
      // Mesma pessoa, provider novo pra essa conta — vincula em vez de
      // duplicar.
      await linkIdentity(db, existingByEmail.id, provider, providerUserId)
      const refreshed = await refreshAvatar(db, existingByEmail, profile)
      return { user: refreshed, isNew: false }
    }
  }

  // `users.provider`/`provider_user_id` continuam existindo na tabela
  // (ver migrations/0004) só como metadado histórico de qual provider
  // criou essa conta — quem resolve login daqui pra frente é sempre
  // `user_identities`, nunca essas duas colunas.
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

  const userId = insert.meta.last_row_id
  await linkIdentity(db, userId, provider, providerUserId)

  const created = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<User>()

  if (!created) {
    throw new Error('Falha ao criar usuário')
  }

  return { user: created, isNew: true }
}

export async function getUserById(db: D1Database, id: number): Promise<User | null> {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>()
  return user ?? null
}
