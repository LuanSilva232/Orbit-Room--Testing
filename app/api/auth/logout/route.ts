import { NextResponse } from 'next/server'
import { destroySession } from '@/lib/auth'

// Encerra a sessão no servidor e limpa o cookie.
export async function POST() {
  await destroySession()
  return NextResponse.json({ ok: true })
}
