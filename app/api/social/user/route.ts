import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getSql } from '@/db/index'

type Row = Record<string, any>

// Perfil público de outro usuário para a aba Amigos / popups.
export async function GET(req: NextRequest) {
  const targetId = req.nextUrl.searchParams.get('userId') || ''
  if (!targetId) return NextResponse.json({ ok: false, error: 'USER_REQUIRED' }, { status: 400 })

  const user = await getCurrentUser()
  const sql = getSql()

  const [u] = await sql`
    SELECT id, display_name, photo, cover, bio FROM users WHERE id = ${targetId} LIMIT 1
  `
  if (!u) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 })

  const friends = await sql`
    SELECT u2.id, u2.display_name, u2.photo, r.channel AS online_channel, r.client_id
    FROM social_friends sf
    JOIN users u2 ON u2.id = CASE WHEN sf.user_a = ${targetId} THEN sf.user_b ELSE sf.user_a END
    LEFT JOIN rtc_clients r ON r.user_id = u2.id
    WHERE sf.user_a = ${targetId} OR sf.user_b = ${targetId}
    ORDER BY u2.display_name LIMIT 60
  `
  const followers = await sql`
    SELECT u2.id, u2.display_name, u2.photo FROM social_follows f JOIN users u2 ON u2.id = f.follower_id
    WHERE f.followee_id = ${targetId} ORDER BY f.created_at DESC LIMIT 60
  `
  const following = await sql`
    SELECT u2.id, u2.display_name, u2.photo FROM social_follows f JOIN users u2 ON u2.id = f.followee_id
    WHERE f.follower_id = ${targetId} ORDER BY f.created_at DESC LIMIT 60
  `

  // Relação com quem está vendo (se logado).
  const relation = {
    isFriend: false,
    isFollowing: false,
    isSelf: false,
  }
  if (user && user.id !== targetId) {
    const [fr] = await sql`
      SELECT 1 AS x FROM social_friends
      WHERE (user_a = ${user.id} AND user_b = ${targetId}) OR (user_a = ${targetId} AND user_b = ${user.id}) LIMIT 1
    `
    const [fw] = await sql`
      SELECT 1 AS y FROM social_follows WHERE follower_id = ${user.id} AND followee_id = ${targetId} LIMIT 1
    `
    relation.isFriend = !!fr
    relation.isFollowing = !!fw
  } else if (user && user.id === targetId) {
    relation.isSelf = true
  }

  // Privacidade: só amigos (ou o próprio perfil) enxergam as LISTAS de amigos/
  // seguidores/seguindo. Para os demais, apenas os números ficam visíveis.
  const canSeeLists = relation.isSelf || relation.isFriend

  const mapBasic = (r: Row) => ({ id: r.id, name: r.display_name, photo: r.photo ?? null })

  return NextResponse.json({
    ok: true,
    user: {
      id: u.id,
      name: u.display_name || 'Usuário',
      photo: u.photo ?? null,
      cover: u.cover ?? null,
      bio: u.bio ?? null,
    },
    relation,
    friendsCount: friends.length,
    followersCount: followers.length,
    followingCount: following.length,
    friends: canSeeLists
      ? friends.map((r: Row) => ({
          id: r.id,
          name: r.display_name,
          photo: r.photo ?? null,
          online: typeof r.client_id === 'string',
          channelId: r.online_channel ?? null,
        }))
      : [],
    followers: canSeeLists ? followers.map(mapBasic) : [],
    following: canSeeLists ? following.map(mapBasic) : [],
  })
}