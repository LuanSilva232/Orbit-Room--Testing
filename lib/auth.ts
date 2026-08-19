import 'server-only'

import { cookies } from 'next/headers'
import { createHash, randomBytes } from 'crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { ensureDb, getSql } from '@/db/index'

export const SESSION_COOKIE = 'orbit_session'
export const SESSION_DAYS = 30
const STATE_TTL_MS = 10 * 60 * 1000 // estado/PKCE válido por 10 min

export class AuthError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Helpers de criptografia
// ---------------------------------------------------------------------------

const base64url = (buf: Buffer | Uint8Array) =>
  Buffer.from(buf).toString('base64url')

const sha256Hex = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex')

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest()

const randomStr = (bytes = 24) => base64url(randomBytes(bytes))

function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  }
}

export function googleAuthConfigured(): boolean {
  const c = googleConfig()
  return Boolean(c.clientId && c.clientSecret && c.redirectUri)
}

export function googleAuthConfig(): {
  clientId: string
  redirectUri: string
} {
  const c = googleConfig()
  return { clientId: c.clientId, redirectUri: c.redirectUri }
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface SanitizedUser {
  id: string
  email: string
  name: string
  bio: string | null
  photo: string | null
  rooms: unknown[]
}

// ---------------------------------------------------------------------------
// Início do fluxo OAuth (gera state + PKCE e grava no banco)
// ---------------------------------------------------------------------------

export async function beginGoogleLogin(redirectTo: string): Promise<{ url: string }> {
  const c = googleConfig()
  if (!googleAuthConfigured()) {
    throw new AuthError(
      'GOOGLE_NOT_CONFIGURED',
      'O login com Google ainda não foi configurado neste app.'
    )
  }
  const safeRedirect = sanitizeRedirect(redirectTo)
  const state = randomStr(24)
  const codeVerifier = randomStr(32)
  const challenge = base64url(sha256(codeVerifier))
  const now = Date.now()

  await ensureDb()
  await getSql()`
    INSERT INTO oauth_states (id, state, code_verifier, redirect_to, created_at, expires_at)
    VALUES (${randomStr(12)}, ${state}, ${codeVerifier}, ${safeRedirect}, ${now}, ${now + STATE_TTL_MS})
  `

  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  })

  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` }
}

function sanitizeRedirect(p: string): string {
  const v = (p || '').trim()
  if (!v.startsWith('/') || v.startsWith('//')) return '/'
  if (v.split('/').some((seg) => seg === '..')) return '/'
  return v
}

// ---------------------------------------------------------------------------
// Callback: troca o code, valida o ID token e abre a sessão
// ---------------------------------------------------------------------------

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs')
)

interface GoogleClaims {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

export async function completeGoogleLogin(code: string, state: string): Promise<{
  redirectTo: string
  sessionToken: string
}> {
  const c = googleConfig()
  if (!c.clientId || !c.clientSecret || !c.redirectUri) {
    throw new AuthError('GOOGLE_NOT_CONFIGURED', 'Login com Google não configurado.')
  }

  const sql = getSql()

  // Consome o estado gravado (valida e apaga em uma única transação lógica).
  const now = Date.now()
  await ensureDb()
  const [stored] = await sql`
    SELECT state, code_verifier, redirect_to
    FROM oauth_states
    WHERE state = ${state} AND expires_at > ${now}
  `
  if (!stored) {
    throw new AuthError('INVALID_STATE', 'A solicitação de login expirou ou é inválida. Tente novamente.')
  }
  await sql`DELETE FROM oauth_states WHERE state = ${state}`

  // Troca o code de autorização por tokens.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: stored.code_verifier,
    }),
  })
  if (!tokenRes.ok) {
    throw new AuthError('TOKEN_EXCHANGE_FAILED', 'Não foi possível confirmar seu login com o Google.')
  }
  const tokenData = (await tokenRes.json()) as { id_token?: string }

  // Valida o ID token (audiência, emissor, validade e e-mail verificado).
  let claims: GoogleClaims
  try {
    const { payload } = await jwtVerify(tokenData.id_token || '', GOOGLE_JWKS, {
      audience: c.clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    })
    claims = payload as unknown as GoogleClaims
  } catch {
    throw new AuthError('INVALID_TOKEN', 'Falha ao validar a identidade do Google.')
  }
  if (!claims.sub || !claims.email || claims.email_verified !== true) {
    throw new AuthError('UNVERIFIED_EMAIL', 'Sua conta do Google precisa ter e-mail verificado.')
  }
  const sub = claims.sub
  const email = claims.email
  const displayName = claims.name || claims.email
  const picture = claims.picture || null

  // Cria/reutiliza a conta e vincula (provider, sub) numa transação.
  const sessionToken = randomStr(32)
  const sessionId = randomStr(12)
  const userId = await sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT user_id FROM oauth_accounts
      WHERE provider = 'google' AND provider_subject = ${sub}
    `
    if (existing) return existing.user_id as string

    const [byEmail] = await tx`
      SELECT id FROM users WHERE email = ${email}
    `
    let uid: string
    if (byEmail) {
      uid = byEmail.id as string
      await tx`UPDATE users SET updated_at = ${now} WHERE id = ${uid}`
    } else {
      uid = randomStr(16)
      await tx`
        INSERT INTO users (id, email, email_verified_at, status, display_name, bio, photo, rooms, created_at, updated_at)
        VALUES (${uid}, ${email}, ${now}, 'active', ${displayName}, null, ${picture}, '[]'::jsonb, ${now}, ${now})
      `
    }
    await tx`
      INSERT INTO oauth_accounts (id, user_id, provider, provider_subject, created_at)
      VALUES (${randomStr(16)}, ${uid}, 'google', ${sub}, ${now})
    `
    return uid
  })

  // Abre a sessão.
  await sql`
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
    VALUES (${sessionId}, ${userId}, ${sha256Hex(sessionToken)}, ${now}, ${now + SESSION_DAYS * 24 * 60 * 60 * 1000})
  `

  return { redirectTo: stored.redirect_to || '/', sessionToken }
}

// ---------------------------------------------------------------------------
// Sessão atual
// ---------------------------------------------------------------------------

export async function getCurrentUser(): Promise<SanitizedUser | null> {
  const c = await cookies()
  const token = c.get(SESSION_COOKIE)?.value
  if (!token) return null
  const now = Date.now()
  await ensureDb()
  const rows = await getSql()`
    SELECT u.id, u.email, u.display_name, u.bio, u.photo, u.rooms, u.status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256Hex(token)}
      AND s.expires_at > ${now}
      AND u.status = 'active'
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id as string,
    email: row.email as string,
    name: (row.display_name as string) || '',
    bio: (row.bio as string | null) ?? null,
    photo: (row.photo as string | null) ?? null,
    rooms: Array.isArray(row.rooms) ? (row.rooms as unknown[]) : [],
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function destroySession(): Promise<void> {
  const c = await cookies()
  const token = c.get(SESSION_COOKIE)?.value
  if (token) {
    await ensureDb()
    await getSql()`DELETE FROM sessions WHERE token_hash = ${sha256Hex(token)}`
  }
  c.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 })
}
