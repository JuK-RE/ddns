-- Migration number: 0001 	 2026-09-15T21:00:00.000Z
CREATE TABLE IF NOT EXISTS system_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
