import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getSql } from '@/db/index'

const GRACE_MS = 3 * 24 * 60 * 60 * 1000 // 3 dias de carência para "se arrepender"

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64) || null
  const via = req.headers.get('x-real-ip')
  return via ? via.slice(0, 64) : null
}

async function readDeleteAt(userId: string): Promise<number | null> {
  const rows = await getSql()<{ delete_scheduled_at: string | number | null }[]>`
    SELECT delete_scheduled_at FROM users WHERE id = ${userId}
  `
  const v = rows[0]?.delete_scheduled_at
  return v == null ? null : Number(v)
}

// Gerencia a exclusão da conta logada: agenda (3 dias), cancela ou consulta o status.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  let action = 'status'
  try {
    const body = (await req.json()) as { action?: string }
    if (body.action && ['schedule-delete', 'cancel-delete', 'status'].includes(body.action)) {
      action = body.action
    }
  } catch {
    // corpo opcional: sem corpo, devolve só o status
  }

  const ip = clientIp(req)

  if (action === 'schedule-delete') {
    const at = Date.now() + GRACE_MS
    await getSql()`
      UPDATE users
      SET delete_scheduled_at = ${at}, last_ip = COALESCE(${ip ?? null}, last_ip), updated_at = ${Date.now()}
      WHERE id = ${user.id}
    `
    return NextResponse.json({ ok: true, deleteScheduledAt: at })
  }

  if (action === 'cancel-delete') {
    await getSql()`
      UPDATE users
      SET delete_scheduled_at = NULL, last_ip = COALESCE(${ip ?? null}, last_ip), updated_at = ${Date.now()}
      WHERE id = ${user.id}
    `
    return NextResponse.json({ ok: true, deleteScheduledAt: null })
  }

  // status
  return NextResponse.json({ ok: true, deleteScheduledAt: await readDeleteAt(user.id) })
}
