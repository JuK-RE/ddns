-- Migration number: 0006 	 2026-09-27T00:00:01.000Z
-- Hosts DDNS. Datas no formato do SQLite (UTC, 'YYYY-MM-DD HH:MM:SS');
-- a API converte pra ISO 8601 na saída.
CREATE TABLE IF NOT EXISTS hosts (
  id                 TEXT PRIMARY KEY,                    -- uuid
  user_id            INTEGER NOT NULL REFERENCES users(id),
  zone_id            INTEGER NOT NULL REFERENCES zones(id),
  label              TEXT NOT NULL,                       -- 'Clínica Asa Sul'
  name               TEXT NOT NULL,                       -- 'clinicajuca' (minúsculo)
  fqdn               TEXT NOT NULL,                       -- 'clinicajuca.ip.juk.re'
  connector          TEXT NOT NULL,                       -- 'http' | 'mikrotik' | 'pfsense' | 'unifi' | 'ddclient' | 'cli'
  token_hash         TEXT NOT NULL UNIQUE,                -- sha256 (hex) do token
  token_prefix       TEXT NOT NULL,                       -- 'jukre_Q2x9' (pra reconhecer no painel)
  last_ipv4          TEXT,
  cf_record_a_id     TEXT,                                -- id do registro A na Cloudflare
  last_check_at      TEXT,                                -- última chamada do conector (gravada no máx. 1x/hora se o IP não mudou)
  last_change_at     TEXT,                                -- última vez que o IP mudou
  last_user_agent    TEXT,
  cf_cleanup_pending INTEGER NOT NULL DEFAULT 0,          -- 1 = excluído, mas o registro na Cloudflare não pôde ser apagado
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT
);

-- nome único por zona entre hosts ativos
CREATE UNIQUE INDEX IF NOT EXISTS hosts_active_name ON hosts(zone_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS hosts_user ON hosts(user_id) WHERE deleted_at IS NULL;
-- consulta de quarentena (nome + zona, incluindo excluídos)
CREATE INDEX IF NOT EXISTS hosts_name_zone ON hosts(zone_id, name);
