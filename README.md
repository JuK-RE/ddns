<div style="text-align: center;">
  <img width="455" height="128" alt="jukre-ascii-art-text" src="https://github.com/user-attachments/assets/73cec220-253f-4d5b-8126-0cac517b7d32" />
</div>

### JUK.re DDNS A powerful DDNS system

## Arquitetura

- **Front** (`ddns-ui`, Vercel): `https://ddns.juk.re`. Repassa `/api/*` pra este Worker (rewrite no `vercel.json`), então o navegador só fala com o próprio domínio.
- **Back** (este repo, Cloudflare Workers + D1): as rotas respondem em `/api/...` (via front) e em `/...` (acesso direto, pra CLI/roteadores).

### Sessão

- **Navegador:** cookie `__Host-ddns_session` (`httpOnly`, `Secure`, `SameSite=Lax`), setado no login OAuth. O token nunca vai na URL nem fica acessível ao JavaScript.
- **CLI / roteadores:** `Authorization: Bearer <token>`.
- **CSRF:** `POST`/`PUT`/`PATCH`/`DELETE` autenticados por cookie só passam vindos de `FRONTEND_URL` (ou `localhost:5173`). O logout é `POST /auth/logout`.

### OAuth: URLs de callback

Cadastre nos providers, trocando pela URL do front de cada ambiente:

- Google Cloud Console → URIs de redirecionamento autorizadas: `https://ddns.juk.re/api/auth/google`
- GitHub → OAuth App → Authorization callback URL: `https://ddns.juk.re/api/auth/github` (o OAuth App só aceita uma URL; use um app separado pra dev)

### Dev

```bash
cp .dev.vars.example .dev.vars   # preencha os segredos; FRONTEND_URL=http://localhost:5173
pnpm dev                         # wrangler dev na porta 8787
```

No `ddns-ui`, o `pnpm dev` já repassa `/api` pra `http://localhost:8787`.

## DDNS (hosts)

Rotas do painel (`/api/zones`, `/api/hosts*`, autenticadas pela sessão) e rotas **públicas** de atualização, chamadas direto em `gateway.juk.re` por roteadores/curl/CLI e autenticadas pelo token do host:

- `GET /v1/update/<token>[?myip=…][&format=text]` (também aceita `Authorization: Bearer <token>` em `/v1/update`)
- `GET /nic/update?hostname=…&myip=…`, compatível com **dyndns2** (Basic auth: usuário = hostname, senha = token)
- `GET /v1/ip`

O IP pode ser **IPv4** (registro A) ou **IPv6** (registro AAAA): quem decide é a família do endereço em `myip` (ou o IP de quem chamou). Com o "DDNS ativo" desligado no painel, a atualização responde `403 disabled` (`nohost` no dyndns2).

Rotas do painel novas: `PATCH /api/hosts/:id/dns` (`{ ddns_enabled?, ipv4?, ipv6? }`, edição manual do registro).

Decisões em `docs/planejamento-ddns-hosts.md` (ADR-003 no projeto).

### Configuração (uma vez)

1. **Token da Cloudflare:** crie um API Token com **Zone → DNS → Edit** só na zona `juk.re`.
   ```bash
   wrangler secret put CF_API_TOKEN
   wrangler secret put CF_ZONE_ID     # id da zona juk.re (ou preencha zones.cf_zone_id no D1)
   ```
   Pra dev local, coloque os dois no `.dev.vars`. (Opcional, só pra testes: `CF_API_BASE` aponta pra um mock da API da Cloudflare.)
2. **Migrations** (0005–0007 criam `zones` com o seed, `hosts` e `host_ip_history`; a 0008 adiciona IPv6 e a chave "DDNS ativo"):
   ```bash
   pnpm db:migrations
   ```
3. **Administradores:** a página de Versões (e a rota `/versions`) só existe para admins. Defina os e-mails no secret, separados por vírgula:
   ```bash
   wrangler secret put ADMIN_EMAILS   # ex.: voce@exemplo.com,outro@exemplo.com
   ```
   Sem o secret, ninguém é admin. (O e-mail é a chave da conta: contas do mesmo e-mail em provedores diferentes são a mesma pessoa.)
4. **Rate limiting:** os bindings `DDNS_UPDATE_LIMITER` e `DDNS_AUTHFAIL_LIMITER` já estão no `wrangler.jsonc` (`ratelimits`).
5. **Domínio:** o intervalo mínimo de 5 min usa a Cache API, que só funciona em domínio próprio (`gateway.juk.re`), não em `*.workers.dev`.
6. Antes de liberar uma zona nova, confira que não há registro "de verdade" com o mesmo nome dentro dela (o front está em `ddns.juk.re`; `www`, `api` etc. já são nomes reservados).

> ⚠️ Nunca logue a URL, a query ou os headers das rotas públicas: o token viaja neles.
