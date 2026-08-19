import { NextResponse, type NextRequest } from 'next/server'
import { completeGoogleLogin, SESSION_COOKIE, SESSION_DAYS } from '@/lib/auth'

// Callback do Google: valida e abre a sessão.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const loginUrl = new URL('/login', req.url)

  if (!code || !state) {
    loginUrl.searchParams.set('error', 'INVALID_CALLBACK')
    return NextResponse.redirect(loginUrl)
  }

  try {
    const { redirectTo, sessionToken } = await completeGoogleLogin(code, state)
    const res = NextResponse.redirect(new URL(redirectTo, req.url))
    res.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    })
    return res
  } catch (err) {
    const codeName =
      err instanceof Error && 'code' in err ? (err as { code: string }).code : 'error'
    loginUrl.searchParams.set('error', codeName)
    return NextResponse.redirect(loginUrl)
  }
}
