import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getSql } from '@/db/index'

// Perfil salvo na conta (nome, bio, foto e salas).
export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  return NextResponse.json({
    profile: {
      name: user.name,
      bio: user.bio,
      photo: user.photo,
      rooms: user.rooms,
    },
  })
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
  const rooms = Array.isArray(body.rooms) ? body.rooms : user.rooms

  if (!name) {
    return NextResponse.json({ error: 'NAME_REQUIRED' }, { status: 400 })
  }

  await getSql()`
    UPDATE users
    SET display_name = ${name},
        bio = ${bio},
        photo = ${photo},
        rooms = ${JSON.stringify(rooms)}::jsonb,
        updated_at = ${Date.now()}
    WHERE id = ${user.id}
  `

  return NextResponse.json({ ok: true, profile: { name, bio, photo, rooms } })
}
