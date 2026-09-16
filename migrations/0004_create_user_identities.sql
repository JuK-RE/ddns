-- Migration number: 0004 	 2026-09-16T20:35:41.000Z

-- Até aqui, provider/provider_user_id viviam na própria tabela `users`,
-- ou seja: 1 provider = 1 linha de usuário. Login com um segundo
-- provider cujo e-mail o app não conseguisse casar exatamente com o já
-- cadastrado (ex.: GitHub com e-mail privado, retornando um alias tipo
-- "12345+user@users.noreply.github.com" em vez do e-mail real) criava
-- um SEGUNDO usuário pra mesma pessoa, em vez de vincular ao existente.
--
-- Esta migração:
--   1. cria `user_identities` (1 usuário -> N providers, com
--      UNIQUE(provider, provider_user_id) garantindo que a mesma conta
--      de um provider nunca fique vinculada a dois usuários);
--   2. migra os dados hoje presos em `users.provider` /
--      `users.provider_user_id` pra lá;
--   3. funde usuários que hoje têm o MESMO e-mail (não-nulo) em um só —
--      repontua identidades e sessões pra linha "canônica" (menor id) e
--      apaga as duplicadas.
--
-- OBS: as colunas `provider`/`provider_user_id` continuam existindo em
-- `users` (não dá pra recriar a tabela nesta migração — o D1 roda com
-- PRAGMA foreign_keys ativo, e um DROP TABLE em `users` falha com
-- FOREIGN KEY constraint failed enquanto `sessions`/`user_identities`
-- ainda referenciam ela, mesmo dentro da mesma transação). Elas ficam
-- como metadado histórico ("por qual provider esse usuário foi criado
-- originalmente") e o código não lê mais delas pra autenticar — quem
-- resolve login agora é sempre `user_identities`.

CREATE TABLE IF NOT EXISTS user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities(user_id);

-- 1 identidade por linha de `users` que já existe hoje.
INSERT INTO user_identities (user_id, provider, provider_user_id, created_at)
SELECT id, provider, provider_user_id, created_at FROM users;

-- Funde usuários que compartilham o mesmo e-mail (não-nulo): repontua
-- identidades e sessões das linhas duplicadas pra linha canônica (o
-- menor id entre as que têm aquele e-mail).
UPDATE user_identities
SET user_id = (
  SELECT MIN(u2.id) FROM users u2
  WHERE u2.email = (SELECT u1.email FROM users u1 WHERE u1.id = user_identities.user_id)
)
WHERE user_id IN (
  SELECT u.id FROM users u
  WHERE u.email IS NOT NULL
    AND u.id <> (SELECT MIN(u2.id) FROM users u2 WHERE u2.email = u.email)
);

UPDATE sessions
SET user_id = (
  SELECT MIN(u2.id) FROM users u2
  WHERE u2.email = (SELECT u1.email FROM users u1 WHERE u1.id = sessions.user_id)
)
WHERE user_id IN (
  SELECT u.id FROM users u
  WHERE u.email IS NOT NULL
    AND u.id <> (SELECT MIN(u2.id) FROM users u2 WHERE u2.email = u.email)
);

-- Apaga as linhas duplicadas (mantém só a canônica por e-mail). Nesse
-- ponto nenhuma linha de `sessions`/`user_identities` aponta mais pra
-- elas (já repontuamos acima), então o DELETE não esbarra na FK.
DELETE FROM users
WHERE email IS NOT NULL
  AND id <> (SELECT MIN(u2.id) FROM users u2 WHERE u2.email = users.email);
