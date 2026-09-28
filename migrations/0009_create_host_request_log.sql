-- Migration number: 0009 	 2026-09-28T12:00:00.000Z
-- Log das chamadas de atualização (/v1/update e /nic/update) por host.
-- Serve pra confirmar no painel que o conector está chamando a API e o que
-- ela respondeu. Guarda só as 30 mais recentes de cada host: a cada nova
-- linha, as mais antigas são apagadas (ver services/requestLog.ts).
--
-- Nunca guarda token, URL ou headers além do user-agent.
CREATE TABLE IF NOT EXISTS host_request_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     TEXT NOT NULL REFERENCES hosts(id),
  source      TEXT NOT NULL,                  -- 'v1' | 'dyndns2'
  result      TEXT NOT NULL,                  -- 'updated' | 'unchanged' | 'disabled' | 'rate_limited' | 'nohost' | 'bad_ip' | 'error'
  status      INTEGER NOT NULL,               -- status HTTP devolvido
  record_type TEXT,                           -- 'A' | 'AAAA' (null se o IP não foi aceito)
  ip          TEXT,                           -- IP que a chamada pediu pra gravar (myip ou o de origem)
  caller_ip   TEXT,                           -- IP de onde a chamada saiu
  user_agent  TEXT,
  message     TEXT,                           -- detalhe curto (ex.: motivo do bad_ip)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS host_request_log_host ON host_request_log(host_id, id DESC);
