import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'

// Estado da sessão atual (só dados saneados).
export async function GET() {
  const user = await getCurrentUser()
  return NextResponse.json({ user })
}
