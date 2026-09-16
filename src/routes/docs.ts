import { Hono } from 'hono'
import type { AppVariables } from '../types'

type Env = { Bindings: CloudflareBindings; Variables: AppVariables }

const docs = new Hono<Env>()

// Spec OpenAPI 3.0 escrita à mão, refletindo as rotas atuais da API.
// Não há geração automática (as rotas não usam zod-openapi) — ao
// adicionar/alterar uma rota, atualize aqui também.
docs.get('/openapi.json', (c) => {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'ddns-api',
      description: 'API do DDNS (JUK.re) — autenticação via GitHub OAuth e gerenciamento de versões.',
      version: '1.0.0',
    },
    servers: [{ url: '/', description: 'Origem atual' }],
    tags: [
      { name: 'auth', description: 'Login via GitHub e sessão' },
      { name: 'versions', description: 'Versões do sistema' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token retornado por /auth/github, enviado como "Authorization: Bearer <token>".',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            provider: { type: 'string', example: 'github' },
            provider_user_id: { type: 'string' },
            username: { type: 'string', nullable: true },
            email: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            avatar_url: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Version: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            version: { type: 'string', example: '1.2.0' },
            description: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
    paths: {
      '/': {
        get: {
          summary: 'Healthcheck',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/auth/github': {
        get: {
          tags: ['auth'],
          summary: 'Inicia ou finaliza o login com GitHub',
          description:
            'Sem `?code=`: redireciona pro GitHub. Com `?code=` (callback do GitHub): troca pelo token, cria a sessão e redireciona pro front com `#token=<jwt>`.',
          parameters: [
            {
              name: 'code',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Código de autorização enviado pelo GitHub no callback.',
            },
          ],
          responses: {
            '302': { description: 'Redirect (pro GitHub, ou de volta pro front com o token)' },
            '401': {
              description: 'Falha na autenticação com o GitHub',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
      '/auth/logout': {
        get: {
          tags: ['auth'],
          summary: 'Logout',
          description: 'Sem estado no servidor — o front só descarta o token salvo localmente.',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
            },
          },
        },
      },
      '/auth/me': {
        get: {
          tags: ['auth'],
          summary: 'Usuário logado a partir do token',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Usuário atual (ou null, se não autenticado)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { user: { anyOf: [{ $ref: '#/components/schemas/User' }, { nullable: true }] } },
                  },
                },
              },
            },
          },
        },
      },
      '/versions': {
        get: {
          tags: ['versions'],
          summary: 'Lista as versões cadastradas',
          responses: {
            '200': {
              description: 'Lista de versões, mais recente primeiro',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { versions: { type: 'array', items: { $ref: '#/components/schemas/Version' } } },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['versions'],
          summary: 'Registra uma nova versão',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['version'],
                  properties: {
                    version: { type: 'string', example: '1.2.0' },
                    description: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Versão criada',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { version: { $ref: '#/components/schemas/Version' } } },
                },
              },
            },
            '400': {
              description: 'Campo "version" ausente',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '401': {
              description: 'Não autenticado',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
    },
  }

  return c.json(spec)
})

// Swagger UI servido via CDN (unpkg) — sem depender de instalar
// @hono/swagger-ui ou qualquer outro pacote novo no projeto.
docs.get('/sw', (c) => {
  return c.html(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>ddns-api — Swagger UI</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>body { margin: 0; background: #fafafa; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/docs/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
      })
    </script>
  </body>
</html>`)
})

export default docs
