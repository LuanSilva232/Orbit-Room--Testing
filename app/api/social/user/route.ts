import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getSql } from '@/db/index'
import * as social from '@/lib/social'

// Perfil social de outro usuário: relação, listas de amigos/seguidores e presença.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const url = new URL(req.url)
  const userId = url.searchParams.get('userId') ?? ''
  if (!userId) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }
  try {
    return NextResponse.json(await social.getTargetSocial(user.id, userId))
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? Number((error as { status?: number }).status) : 500
    const message = error instanceof Error ? error.message : 'Erro interno'
    return NextResponse.json({ error: message }, { status: Number.isFinite(status) ? status : 500 })
  }
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  let body: {
    name?: string
    bio?: string
    photo?: string
    cover?: string
    rooms?: unknown[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : user.name
  const bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 240) : (user.bio ?? null)
  const photo = typeof body.photo === 'string' ? body.photo : (user.photo ?? null)
  const cover = typeof body.cover === 'string' ? body.cover : (user.cover ?? null)
  const rooms = Array.isArray(body.rooms) ? body.rooms : user.rooms

  if (!name) {
    return NextResponse.json({ error: 'NAME_REQUIRED' }, { status: 400 })
  }

  await getSql()`
    UPDATE users
    SET display_name = ${name},
        bio = ${bio},
        photo = ${photo},
        cover = ${cover},
        rooms = ${JSON.stringify(rooms)}::jsonb,
        updated_at = ${Date.now()}
    WHERE id = ${user.id}
  `

  return NextResponse.json({ ok: true, profile: { name, bio, photo, cover, rooms } })
}
