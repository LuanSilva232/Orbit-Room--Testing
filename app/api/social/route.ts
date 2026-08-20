import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getSql } from '@/db/index'
import { generateFriendCode } from '@/lib/friend-code'

type Row = Record<string, any>

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const sql = getSql()
  const [me] = await sql`
    SELECT u.id, u.display_name, u.photo, u.cover, u.bio, u.friend_code
    FROM users u WHERE u.id = ${user.id}
  `
  const friendCode = ((me?.friend_code as string | null) ?? null) || generateFriendCode()

  const friends = await sql`
    SELECT u.id, u.display_name, u.photo, u.cover, u.bio, u.friend_code,
           r.client_id AS rtc_client, r.channel AS rtc_channel
    FROM social_friends f
    JOIN users u ON u.id = CASE WHEN f.user_a = ${user.id} THEN f.user_b ELSE f.user_a END
    LEFT JOIN rtc_clients r ON r.user_id = u.id
    WHERE f.user_a = ${user.id} OR f.user_b = ${user.id}
    ORDER BY u.display_name
  `

  const requests = await sql`
    SELECT r.id AS request_id, r.from_id, r.created_at, u.display_name, u.photo, u.cover, u.bio, u.friend_code
    FROM social_requests r
    JOIN users u ON u.id = r.from_id
    WHERE r.to_id = ${user.id} AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `

  const followers = await sql`
    SELECT u.id, u.display_name, u.photo, u.cover
    FROM social_follows f JOIN users u ON u.id = f.follower_id
    WHERE f.followee_id = ${user.id} ORDER BY f.created_at DESC
  `
  const following = await sql`
    SELECT u.id, u.display_name, u.photo, u.cover
    FROM social_follows f JOIN users u ON u.id = f.followee_id
    WHERE f.follower_id = ${user.id} ORDER BY f.created_at DESC
  `

  const mapUser = (r: Row) => ({
    id: r.id,
    displayName: r.display_name || 'Usuário',
    photo: r.photo ?? null,
    cover: r.cover ?? null,
    bio: r.bio ?? null,
    code: r.friend_code ?? null,
    online: Boolean(r.rtc_client),
    channelId: r.rtc_channel ?? null,
  })

  return NextResponse.json({
    me: {
      id: user.id,
      email: user.email,
      displayName: user.name,
      photo: user.photo,
      cover: user.cover,
      friendCode,
      friendsCount: friends.length,
      followersCount: followers.length,
      followingCount: following.length,
    },
    friends: friends.map(mapUser),
    requests: requests.map((r: Row) => ({
      requestId: r.request_id,
      fromId: r.from_id,
      createdAt: r.created_at,
      displayName: r.display_name,
      photo: r.photo ?? null,
      cover: r.cover ?? null,
      bio: r.bio ?? null,
      code: r.friend_code ?? null,
    })),
    followers: followers.map((u: Row) => ({ id: u.id, displayName: u.display_name, photo: u.photo ?? null })),
    following: following.map((u: Row) => ({ id: u.id, displayName: u.display_name, photo: u.photo ?? null })),
  })
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let body: { action?: string; toCode?: string; toUserId?: string; fromUserId?: string; userId?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }
  const action = body.action || ''
  const sql = getSql()

  const ensureCode = async (uid: string): Promise<string> => {
    const [u] = await sql<{ friend_code: string | null }[]>`SELECT friend_code FROM users WHERE id = ${uid}`
    if (u?.friend_code) return u.friend_code
    const code = generateFriendCode()
    await sql`UPDATE users SET friend_code = ${code} WHERE id = ${uid}`
    return code
  }
  await ensureCode(user.id)

  if (action === 'send-request') {
    // Aceita o alvo por código OU por id de usuário (perfil/chat).
    let tid: string | undefined
    if (body.toUserId) {
      tid = String(body.toUserId).trim()
      const t = await sql`SELECT id FROM users WHERE id = ${tid} LIMIT 1`
      if (!t[0]) return NextResponse.json({ ok: false, error: 'NOT_FOUND', message: 'Usuário não encontrado.' })
    } else {
      const code = String(body.toCode || '').trim().toUpperCase()
      if (!code || code.length < 4 || code.length > 8) {
        return NextResponse.json({ error: 'CODE_REQUIRED' }, { status: 400 })
      }
      const target = await sql`SELECT id FROM users WHERE friend_code = ${code} AND id <> ${user.id} LIMIT 1`
      tid = target[0]?.id as string | undefined
      if (!tid) return NextResponse.json({ ok: false, error: 'NOT_FOUND', message: 'Código não encontrado.' })
    }
    if (!tid || tid === user.id) return NextResponse.json({ ok: false, error: 'SELF', message: 'Você não pode adicionar a si mesmo.' })

    const already = await sql`
      SELECT 1 FROM social_friends
      WHERE (user_a = ${user.id} AND user_b = ${tid}) OR (user_a = ${tid} AND user_b = ${user.id}) LIMIT 1
    `
    if (already.length) return NextResponse.json({ ok: false, error: 'ALREADY', message: 'Vocês já são amigos.' })

    const pending = await sql`
      SELECT 1 FROM social_requests
      WHERE ((from_id = ${user.id} AND to_id = ${tid}) OR (from_id = ${tid} AND to_id = ${user.id})) AND status = 'pending'
      LIMIT 1
    `
    if (pending.length) return NextResponse.json({ ok: false, error: 'PENDING', message: 'Já existe um convite pendente.' })

    await sql`
      INSERT INTO social_requests (id, from_id, to_id, status, created_at)
      VALUES (${'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)}, ${user.id}, ${tid}, 'pending', ${Date.now()})
      ON CONFLICT (from_id, to_id) DO UPDATE SET status = 'pending', created_at = ${Date.now()}
    `
    return NextResponse.json({ ok: true, message: 'Convite enviado!' })
  }

  if (action === 'accept-request') {
    const fromId = String(body.fromUserId || '')
    const reqCheck = await sql`
      SELECT id FROM social_requests WHERE to_id = ${user.id} AND from_id = ${fromId} AND status = 'pending' LIMIT 1
    `
    if (!reqCheck.length) return NextResponse.json({ ok: false, error: 'NOT_FOUND', message: 'Convite não encontrado.' })
    await sql`UPDATE social_requests SET status = 'accepted' WHERE to_id = ${user.id} AND from_id = ${fromId}`
    await sql`
      INSERT INTO social_friends (user_a, user_b, created_at)
      VALUES (${fromId}, ${user.id}, ${Date.now()}) ON CONFLICT DO NOTHING
    `
    return NextResponse.json({ ok: true, message: 'Agora vocês são amigos!' })
  }

  if (action === 'decline-request') {
    const fromId = String(body.fromUserId || '')
    await sql`
      UPDATE social_requests SET status = 'declined'
      WHERE to_id = ${user.id} AND from_id = ${fromId} AND status = 'pending'
    `
    return NextResponse.json({ ok: true })
  }

  if (action === 'remove-friend') {
    const other = String(body.userId || '')
    if (!other) return NextResponse.json({ ok: false, error: 'USER_REQUIRED' }, { status: 400 })
    await sql`
      DELETE FROM social_friends
      WHERE (user_a = ${user.id} AND user_b = ${other}) OR (user_a = ${other} AND user_b = ${user.id})
    `
    await sql`
      DELETE FROM social_requests
      WHERE (from_id = ${user.id} AND to_id = ${other}) OR (from_id = ${other} AND to_id = ${user.id})
    `
    return NextResponse.json({ ok: true, message: 'Amizade encerrada.' })
  }

  if (action === 'follow') {
    const other = String(body.userId || '')
    if (!other || other === user.id) return NextResponse.json({ ok: false, error: 'USER_REQUIRED' }, { status: 400 })
    await sql`
      INSERT INTO social_follows (follower_id, followee_id, created_at)
      VALUES (${user.id}, ${other}, ${Date.now()}) ON CONFLICT DO NOTHING
    `
    return NextResponse.json({ ok: true })
  }

  if (action === 'unfollow') {
    const other = String(body.userId || '')
    await sql`DELETE FROM social_follows WHERE follower_id = ${user.id} AND followee_id = ${other}`
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 })
}