import type { User } from '../types'

const RESEND_API_URL = 'https://api.resend.com/emails'

function providerLabel(provider: string): string {
  if (provider === 'github') return 'GitHub'
  if (provider === 'google') return 'Google'
  return provider
}

// Layout HTML simples e inline (sem CSS externo — a maioria dos clientes
// de e-mail ignora <style> em tags externas/complexas), reaproveitado
// pelos dois templates abaixo.
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#111827;padding:20px 24px;">
                <span style="color:#ffffff;font-size:18px;font-weight:600;">JUK.re DDNS</span>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;color:#111827;font-size:14px;line-height:1.6;">
                <h1 style="font-size:18px;margin:0 0 12px;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">
                Se você não reconhece essa atividade, entre na sua conta e desconecte a sessão em "Sessões".
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

// Envia um e-mail via Resend. Nunca lança erro pro chamador — login não
// pode falhar (nem atrasar) por causa de e-mail: loga o problema e segue.
// Chamado sempre via `c.executionCtx.waitUntil(...)` nas rotas, pra não
// segurar o redirect do OAuth esperando a entrega.
async function sendEmail(env: CloudflareBindings, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY não configurada — e-mail não enviado:', subject)
    return
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to,
        subject,
        html,
      }),
    })

    if (!res.ok) {
      console.error('Resend respondeu com erro ao enviar e-mail:', res.status, await res.text())
    }
  } catch (err) {
    console.error('Falha ao enviar e-mail via Resend:', err)
  }
}

// Disparado só na primeira vez que o usuário loga (conta recém-criada).
export async function sendWelcomeEmail(env: CloudflareBindings, user: User): Promise<void> {
  if (!user.email) return

  const html = layout(
    `Bem-vindo${user.name ? `, ${user.name}` : ''}!`,
    `<p>Sua conta no JUK.re DDNS foi criada com sucesso via <strong>${providerLabel(user.provider)}</strong>.</p>
     <p>A partir de agora você pode gerenciar seus registros e ver os dispositivos conectados na tela de Sessões.</p>`
  )

  await sendEmail(env, user.email, 'Bem-vindo ao JUK.re DDNS', html)
}

// Disparado em todo login subsequente (usuário já existente).
export async function sendNewLoginEmail(env: CloudflareBindings, user: User, provider: string): Promise<void> {
  if (!user.email) return

  const when = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

  const html = layout(
    'Novo login detectado',
    `<p>Detectamos um login na sua conta via <strong>${providerLabel(provider)}</strong> em ${when} (horário de Brasília).</p>
     <p>Se foi você, pode ignorar este e-mail. Se não reconhece esse acesso, entre na sua conta e desconecte a sessão, ou desconecte todos os dispositivos de uma vez em "Sessões".</p>`
  )

  await sendEmail(env, user.email, 'Novo login na sua conta JUK.re DDNS', html)
}
