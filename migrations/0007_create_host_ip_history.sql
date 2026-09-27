-- Migration number: 0007 	 2026-09-27T00:00:02.000Z
CREATE TABLE IF NOT EXISTS host_ip_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     TEXT NOT NULL REFERENCES hosts(id),
  record_type TEXT NOT NULL DEFAULT 'A',      -- 'A' agora; 'AAAA' na fase 2
  old_ip      TEXT,
  new_ip      TEXT NOT NULL,
  source      TEXT NOT NULL,                  -- 'v1' | 'dyndns2' | 'cli'
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS host_ip_history_host ON host_ip_history(host_id, created_at DESC);
