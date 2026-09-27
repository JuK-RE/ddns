-- Migration number: 0005 	 2026-09-27T00:00:00.000Z
-- Zonas = opções de sufixo pro nome do host (ex.: clinicajuca.ip.juk.re).
-- Todas são registros dentro da zona `juk.re` da Cloudflare.
--
-- cf_zone_id vazio = usa o CF_ZONE_ID do ambiente (var/secret do Worker).
-- Se preferir, preencha depois com:
--   wrangler d1 execute ddns-api-db --remote \
--     --command "UPDATE zones SET cf_zone_id = '<ID_DA_ZONA_JUK_RE>'"
CREATE TABLE IF NOT EXISTS zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  suffix      TEXT NOT NULL UNIQUE,
  cf_zone_id  TEXT NOT NULL DEFAULT '',
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO zones (suffix, description, sort_order) VALUES
  ('ip.juk.re',   'Uso geral',                 10),
  ('ddns.juk.re', 'Uso geral',                 20),
  ('net.juk.re',  'Redes e escritórios',       30),
  ('home.juk.re', 'Casa e home lab',           40),
  ('srv.juk.re',  'Servidores',                50),
  ('cam.juk.re',  'Câmeras e DVR',             60),
  ('rdp.juk.re',  'Acesso remoto (RDP)',       70);
