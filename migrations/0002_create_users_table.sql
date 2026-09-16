-- Migration number: 0002 	 2026-09-16T12:00:00.000Z
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'github',
  provider_user_id TEXT NOT NULL,
  username TEXT,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id)
);
