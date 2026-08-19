import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getSql } from '@/db/index'
import { generateFriendCode } from '@/lib/friend-code'

// Perfil salvo na conta (nome, bio, foto e salas).
export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const rows = await getSql()<{ delete_scheduled_at: string | number | null }[]>`
    SELECT delete_scheduled_at FROM users WHERE id = ${user.id}
  `
  const deleteScheduledAt = rows[0]?.delete_scheduled_at
  // Garante o código de amigo (contas criadas antes do recurso).
  let friendCode = user.friendCode
  if (!friendCode) {
    friendCode = generateFriendCode()
    await getSql()`
      UPDATE users SET friend_code = ${friendCode} WHERE id = ${user.id}
    `
  }
  const social = await getSql()<{ c: string | number }[]>`
    SELECT COUNT(*) AS c FROM social_friends WHERE (user_a = ${user.id} OR user_b = ${user.id})
  `
  const friendsCount = Number(social[0]?.c ?? 0)
  return NextResponse.json({
    profile: {
      name: user.name,
      bio: user.bio,
      photo: user.photo,
      cover: user.cover,
      rooms: user.rooms,
      friendCode,
      friendsCount,
      deleteScheduledAt:
        deleteScheduledAt == null ? null : Number(deleteScheduledAt),
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
