import 'server-only'

import { ensureDb, getSql } from '@/db'
import { AppError } from '@/lib/errors'

// Estado social (amigos, seguidores e convites) persistido no banco em nuvem.

const OFFLINE_MS = 15 * 60 * 1000

type UserRow = {
  id: string
  email: string
  display_name: string
  bio: string | null
  photo: string | null
  cover: string | null
  friend_code: string | null
  privacy_show_online: boolean | null
  privacy_show_lastseen: boolean | null
  privacy_show_room: boolean | null
}

async function userById(id: string): Promise<UserRow | undefined> {
  const rows = await getSql()<UserRow[]>`
    SELECT id, email, display_name, bio, photo, cover, friend_code,
           privacy_show_online, privacy_show_lastseen, privacy_show_room
    FROM users WHERE id = ${id} AND status = 'active'
  `
  return rows[0]
}

export async function requireUser(id: string): Promise<UserRow> {
  await ensureDb()
  const u = await userById(id)
  if (!u) throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND')
  return u
}

// --- Listas básicas ---------------------------------------------------------

async function friendRows(meId: string): Promise<UserRow[]> {
  // A amizade é gravada nas duas direções ((me,X) e (X,me)). Para cada amigo há
  // portanto DOIS registros; o GROUP BY deduplica para o amigo aparecer só uma vez.
  return getSql()<UserRow[]>`
    SELECT u.id, u.email, u.display_name, u.bio, u.photo, u.cover, u.friend_code,
           u.privacy_show_online, u.privacy_show_lastseen, u.privacy_show_room
    FROM social_friends sf
    JOIN users u ON u.id = CASE WHEN sf.user_a = ${meId} THEN sf.user_b ELSE sf.user_a END
    WHERE (sf.user_a = ${meId} OR sf.user_b = ${meId}) AND u.status = 'active'
    GROUP BY u.id, u.email, u.display_name, u.bio, u.photo, u.cover, u.friend_code,
             u.privacy_show_online, u.privacy_show_lastseen, u.privacy_show_room
  `
}

async function requestRows(meId: string): Promise<
  { requestId: string; fromId: string; createdAt: number; displayName: string; photo: string | null; code: string | null }[]
> {
  const rows = await getSql()<{
    id: string
    from_id: string
    created_at: string | number
    display_name: string
    photo: string | null
    friend_code: string | null
  }[]>`
    SELECT r.id, r.from_id, r.created_at, u.display_name, u.photo, u.friend_code
    FROM social_requests r
    JOIN users u ON u.id = r.from_id
    WHERE r.to_id = ${meId} AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `
  return rows.map((r) => ({
    requestId: r.id,
    fromId: r.from_id,
    createdAt: Number(r.created_at),
    displayName: r.display_name,
    photo: r.photo,
    code: r.friend_code,
  }))
}

async function followerRows(meId: string): Promise<{ id: string; display_name: string; photo: string | null }[]> {
  return getSql()<{ id: string; display_name: string; photo: string | null }[]>`
    SELECT u.id, u.display_name, u.photo
    FROM social_follows f JOIN users u ON u.id = f.follower_id
    WHERE f.followee_id = ${meId} AND u.status = 'active'
  `
}

async function followingRows(meId: string): Promise<{ id: string; display_name: string; photo: string | null }[]> {
  return getSql()<{ id: string; display_name: string; photo: string | null }[]>`
    SELECT u.id, u.display_name, u.photo
    FROM social_follows f JOIN users u ON u.id = f.followee_id
    WHERE f.follower_id = ${meId} AND u.status = 'active'
  `
}

/** Canal atual de cada usuário online (user_id -> channel). */
async function onlineChannels(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (userIds.length === 0) return map
  const rows = await getSql()<{ user_id: string; channel: string }[]>`
    SELECT DISTINCT ON (user_id) user_id, channel
    FROM rtc_clients
    WHERE user_id = ANY(${userIds}) AND left_at IS NULL AND last_seen > ${Date.now() - OFFLINE_MS}
    ORDER BY user_id, last_seen DESC
  `
  for (const r of rows) map.set(r.user_id, r.channel)
  return map
}

/** Presença rica dos usuários online: canal + desde quando (joined_at) + última atividade (last_seen). */
type Presence = { channel: string; onlineSince: number; lastSeen: number }
async function presenceFor(userIds: string[]): Promise<Map<string, Presence>> {
  const map = new Map<string, Presence>()
  if (userIds.length === 0) return map
  const rows = await getSql()<{
    user_id: string
    channel: string
    joined_at: string | number
    last_seen: string | number
  }[]>`
    SELECT DISTINCT ON (user_id) user_id, channel, joined_at, last_seen
    FROM rtc_clients
    WHERE user_id = ANY(${userIds}) AND left_at IS NULL AND last_seen > ${Date.now() - OFFLINE_MS}
    ORDER BY user_id, last_seen DESC
  `
  for (const r of rows)
    map.set(r.user_id, {
      channel: r.channel,
      onlineSince: Number(r.joined_at),
      lastSeen: Number(r.last_seen),
    })
  return map
}

/** Última atividade (last_seen) de cada usuário, online ou offline. */
async function lastSeenFor(userIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (userIds.length === 0) return map
  const rows = await getSql()<{ user_id: string; last_seen: string | number }[]>`
    SELECT DISTINCT ON (user_id) user_id, last_seen
    FROM rtc_clients
    WHERE user_id = ANY(${userIds})
    ORDER BY user_id, last_seen DESC
  `
  for (const r of rows) map.set(r.user_id, Number(r.last_seen))
  return map
}

// --- Resumo completo (painel "Amigos" + "Amigos online") --------------------

export type SocialOverview = {
  me: {
    id: string
    email: string
    displayName: string
    photo: string | null
    cover: string | null
    friendCode: string
    friendsCount: number
    followersCount: number
    followingCount: number
  }
  friends: {
    id: string
    name: string
    photo: string | null
    cover: string | null
    bio: string | null
    code: string | null
    online: boolean
    channelId: string | null
    onlineSince: number | null
    lastSeen: number | null
  }[]
  requests: {
    requestId: string
    fromId: string
    createdAt: number
    displayName: string
    photo: string | null
    code: string | null
  }[]
  followers: { id: string; displayName: string; photo?: string | null }[]
  following: { id: string; displayName: string; photo?: string | null }[]
}

export async function getSocialOverview(meId: string): Promise<SocialOverview> {
  const me = await requireUser(meId)
  const [friends, requests, followers, following] = await Promise.all([
    friendRows(meId),
    requestRows(meId),
    followerRows(meId),
    followingRows(meId),
  ])
  const online = await presenceFor(friends.map((f) => f.id))
  const lastSeen = await lastSeenFor(friends.map((f) => f.id))
  return {
    me: {
      id: me.id,
      email: me.email,
      displayName: me.display_name,
      photo: me.photo,
      cover: me.cover,
      friendCode: me.friend_code ?? '',
      friendsCount: friends.length,
      followersCount: followers.length,
      followingCount: following.length,
    },
    friends: friends.map((f) => {
      const showOnline = f.privacy_show_online ?? true
      const showLastseen = f.privacy_show_lastseen ?? true
      const showRoom = f.privacy_show_room ?? true
      const p = showOnline ? online.get(f.id) : undefined
      return {
        id: f.id,
        name: f.display_name,
        photo: f.photo,
        cover: f.cover,
        bio: f.bio,
        code: f.friend_code,
        online: Boolean(p),
        channelId: showRoom && p ? p.channel : null,
        onlineSince: p?.onlineSince ?? null,
        lastSeen: showLastseen ? lastSeen.get(f.id) ?? null : null,
      }
    }),
    requests,
    followers: followers.map((f) => ({ id: f.id, displayName: f.display_name, photo: f.photo })),
    following: following.map((f) => ({ id: f.id, displayName: f.display_name, photo: f.photo })),
  }
}

// --- Perfil de outro usuário (relação + listas) ----------------------------

export type TargetSocial = {
  relation: { isFriend: boolean; isFollowing: boolean; isSelf: boolean }
  requestStatus: 'sent' | 'received' | null
  friendsCount: number
  followersCount: number
  followingCount: number
  friends: { id: string; name: string; photo: string | null; online: boolean }[]
  followers: { id: string; name: string; photo: string | null }[]
  following: { id: string; name: string; photo: string | null }[]
  user: { online: boolean }
}

export async function getTargetSocial(meId: string, targetId: string): Promise<TargetSocial> {
  const target = await requireUser(targetId) // valida que o usuário existe
  const isSelf = meId === targetId

  const [[friendRel], [followRel], [sentRel], [receivedRel], friends, followers, following] =
    await Promise.all([
      getSql()`SELECT 1 FROM social_friends
        WHERE (user_a = ${meId} AND user_b = ${targetId}) OR (user_a = ${targetId} AND user_b = ${meId})`,
      getSql()`SELECT 1 FROM social_follows WHERE follower_id = ${meId} AND followee_id = ${targetId}`,
      getSql()`SELECT 1 FROM social_requests WHERE from_id = ${meId} AND to_id = ${targetId} AND status = 'pending'`,
      getSql()`SELECT 1 FROM social_requests WHERE from_id = ${targetId} AND to_id = ${meId} AND status = 'pending'`,
      friendRows(targetId),
      followerRows(targetId),
      followingRows(targetId),
    ])

  const isFriend = Boolean(friendRel) || isSelf
  const showOnline = target.privacy_show_online ?? true
  const onlineMap = await onlineChannels([targetId])
  const canSeeLists = isSelf || isFriend
  const onlineFriendIds = canSeeLists ? friends.map((f) => f.id) : []
  const onlineFriends = await onlineChannels(onlineFriendIds)

  return {
    relation: { isFriend, isFollowing: Boolean(followRel), isSelf },
    requestStatus: sentRel ? 'sent' : receivedRel ? 'received' : null,
    friendsCount: friends.length,
    followersCount: followers.length,
    followingCount: following.length,
    friends: canSeeLists
      ? friends.map((f) => ({
          id: f.id,
          name: f.display_name,
          photo: f.photo,
          online: (f.privacy_show_online ?? true) && onlineFriends.has(f.id),
        }))
      : [],
    followers: canSeeLists
      ? followers.map((f) => ({ id: f.id, name: f.display_name, photo: f.photo }))
      : [],
    following: canSeeLists
      ? following.map((f) => ({ id: f.id, name: f.display_name, photo: f.photo }))
      : [],
    user: { online: showOnline && onlineMap.has(targetId) },
  }
}

// --- Ações ------------------------------------------------------------------

async function resolveTarget(param: { userId?: string; toCode?: string }): Promise<UserRow> {
  let u: UserRow | undefined
  if (param.userId) {
    u = await userById(param.userId)
  } else if (param.toCode) {
    const code = param.toCode.trim().toUpperCase()
    if (!code) throw new AppError('Digite o código do amigo.', 400, 'CODE_REQUIRED')
    const rows = await getSql()<UserRow[]>`
      SELECT id, email, display_name, bio, photo, cover, friend_code
      FROM users WHERE friend_code = ${code} AND status = 'active'
    `
    u = rows[0]
    if (!u) throw new AppError('Código não encontrado. Confira e tente de novo.', 404, 'CODE_NOT_FOUND')
  }
  if (!u) throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND')
  return u
}

export async function sendFriendRequest(meId: string, param: { userId?: string; toCode?: string }): Promise<void> {
  const target = await resolveTarget(param)
  if (target.id === meId) throw new AppError('Você não pode se adicionar.', 400, 'SELF_REQUEST')

  const [[friendRel], [sent], [received]] = await Promise.all([
    getSql()`SELECT 1 FROM social_friends
      WHERE (user_a = ${meId} AND user_b = ${target.id}) OR (user_a = ${target.id} AND user_b = ${meId})`,
    getSql()`SELECT 1 FROM social_requests WHERE from_id = ${meId} AND to_id = ${target.id} AND status = 'pending'`,
    getSql()`SELECT 1 FROM social_requests WHERE from_id = ${target.id} AND to_id = ${meId} AND status = 'pending'`,
  ])
  if (friendRel) throw new AppError('Vocês já são amigos.', 409, 'ALREADY_FRIENDS')
  if (sent) throw new AppError('Convite já enviado. Aguarde a resposta.', 409, 'REQUEST_SENT')
  if (received) {
    // Já existe um convite dele para você: aceita imediatamente.
    await acceptFriendRequest(meId, target.id)
    return
  }

  await getSql()`
    INSERT INTO social_requests (id, from_id, to_id, status, created_at)
    VALUES (${meId + Date.now()}, ${meId}, ${target.id}, 'pending', ${Date.now()})
  `
}

export async function acceptFriendRequest(meId: string, fromUserId: string): Promise<void> {
  const [req] = await getSql()`
    SELECT id FROM social_requests WHERE from_id = ${fromUserId} AND to_id = ${meId} AND status = 'pending'
  `
  if (!req) throw new AppError('Convite não encontrado.', 404, 'REQUEST_NOT_FOUND')
  const now = Date.now()
  await getSql()`DELETE FROM social_requests WHERE id = ${req.id}`
  await getSql()`INSERT INTO social_friends (user_a, user_b, created_at) VALUES (${meId}, ${fromUserId}, ${now}) ON CONFLICT DO NOTHING`
  await getSql()`INSERT INTO social_friends (user_a, user_b, created_at) VALUES (${fromUserId}, ${meId}, ${now}) ON CONFLICT DO NOTHING`
}

export async function declineFriendRequest(meId: string, fromUserId: string): Promise<void> {
  await getSql()`
    DELETE FROM social_requests WHERE from_id = ${fromUserId} AND to_id = ${meId} AND status = 'pending'
  `
}

export async function removeFriend(meId: string, otherId: string): Promise<void> {
  await getSql()`
    DELETE FROM social_friends
    WHERE (user_a = ${meId} AND user_b = ${otherId}) OR (user_a = ${otherId} AND user_b = ${meId})
  `
}

export async function followUser(meId: string, targetId: string): Promise<void> {
  if (meId === targetId) throw new AppError('Você não pode se seguir.', 400, 'SELF_FOLLOW')
  await requireUser(targetId)
  await getSql()`
    INSERT INTO social_follows (follower_id, followee_id, created_at)
    VALUES (${meId}, ${targetId}, ${Date.now()})
    ON CONFLICT DO NOTHING
  `
}

export async function unfollowUser(meId: string, targetId: string): Promise<void> {
  await getSql()`
    DELETE FROM social_follows WHERE follower_id = ${meId} AND followee_id = ${targetId}
  `
}
