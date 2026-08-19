import { NextResponse, type NextRequest } from 'next/server'
import { beginGoogleLogin } from '@/lib/auth'

// Início do fluxo: redireciona o usuário para o Google.
export async function GET(req: NextRequest) {
  const next = req.nextUrl.searchParams.get('next') || '/'
  try {
    const { url } = await beginGoogleLogin(next)
    return NextResponse.redirect(url)
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : 'error'
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(code)}`, req.url)
    )
  }
}
