-- Migration number: 0003 	 2026-09-16T16:30:00.000Z

-- Sessões de login (uma por token JWT emitido). O `id` é o `jti` gravado
-- no próprio JWT — permite invalidar uma sessão específica antes da
-- expiração ("deslogar remotamente") sem precisar de um blocklist à
-- parte: getSession() sempre confere se a linha ainda existe e não foi
-- revogada, além de verificar a assinatura do token.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
