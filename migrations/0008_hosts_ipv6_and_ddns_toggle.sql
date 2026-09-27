-- Migration number: 0008 	 2026-09-27T12:00:00.000Z
-- IPv6 (registro AAAA) e chave "DDNS ativo/inativo" por host.
--
-- ddns_enabled = 0 → a API ignora as chamadas de atualização do conector
-- (o registro fica como está) e só aceita mudanças manuais pelo painel.
ALTER TABLE hosts ADD COLUMN ddns_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hosts ADD COLUMN last_ipv6 TEXT;
ALTER TABLE hosts ADD COLUMN cf_record_aaaa_id TEXT;
