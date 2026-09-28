-- Migration number: 0009 	 2026-09-28T12:00:00.000Z
-- Log de requisições por host: chamadas de atualização (/v1/update e
-- /nic/update) e ações feitas pelo painel. Serve pra confirmar que o
-- conector está chamando a API e o que ela respondeu. Guarda só as 30 mais recentes de cada host: a cada nova
-- linha, as mais antigas são apagadas (ver services/requestLog.ts).
--
-- Nunca guarda token, URL ou headers além do user-agent.
CREATE TABLE IF NOT EXISTS host_request_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     TEXT NOT NULL REFERENCES hosts(id),
  source      TEXT NOT NULL,                  -- 'v1' | 'dyndns2' | 'panel'
  result      TEXT NOT NULL,                  -- conector: 'updated' | 'unchanged' | 'disabled' | 'rate_limited' | 'nohost' | 'bad_ip' | 'error'
                                              -- painel: 'created' | 'settings_updated' | 'manual_ip' | 'manual_ip_removed' | 'ddns_enabled' | 'ddns_disabled' | 'token_regenerated' | 'error'
  status      INTEGER NOT NULL,               -- status HTTP devolvido
  record_type TEXT,                           -- 'A' | 'AAAA' (null se o IP não foi aceito)
  ip          TEXT,                           -- IP que a chamada pediu pra gravar (myip ou o de origem)
  caller_ip   TEXT,                           -- IP de onde a chamada saiu
  user_agent  TEXT,
  message     TEXT,                           -- detalhe curto (ex.: motivo do bad_ip)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS host_request_log_host ON host_request_log(host_id, id DESC);
