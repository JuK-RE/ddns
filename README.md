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
