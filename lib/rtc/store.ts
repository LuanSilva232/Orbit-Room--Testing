import 'server-only'

import type { JSONValue } from 'postgres'
import type {
  ChannelId,
  ChatMessage,
  MailboxMessage,
  Member,
  Room,
  RoomInvite,
  SignalKind,
} from './types'
import { ensureDb, getSql } from '@/db'
import { AppError } from '@/lib/errors'

// Estado da sala (presença, sinalização, chat e compartilhamento de tela)
// persistido no banco em nuvem. Isso permite funcionar em hospedagens
// serverless (Vercel), onde cada requisição pode cair numa instância diferente
// e o estado precisa ser compartilhado/centralizado.
export const OFFLINE_MS = 15 * 60 * 1000 // 15min sem atividade = offline
export const PRESENT_MS = 3 * 60 * 1000 // 3min sem batimento = não está mais na sala/call (evita "fantasmas")
export const SOLO_KICK_MS = 5 * 60 * 1000 // 5min sozinho na sala = sai do canal automaticamente (oculto)
export const ANON_MSG_MS = 24 * 60 * 60 * 1000 // mensagens de anônimos somem após 24h
export const LOGGED_MSG_MS = 48 * 60 * 60 * 1000 // mensagens de contas logadas somem após 48h
export const ANON_OFFLINE_MS = 15 * 24 * 60 * 60 * 1000 // anônimo offline é apagado após 15 dias (cache temporário)
export const DELETE_GRACE_MS = 3 * 24 * 60 * 60 * 1000 // 3 dias para "se arrepender" antes de excluir a conta
export const MAX_PUBLIC_MEMBERS = 10 // limite por sala pública, para não travar (lentidão)
export const INVITE_TTL_MS = 5 * 60 * 1000 // 5min para aceitar/recusar um convite de sala

// Senha do modo administrador (privilégio). Permite ao admin entrar em qualquer
// sala privada sem senha (usada também para ativar o modo administrador na tela).
export const ADMIN_PASSWORD = '9921174'

type ClientRow = {
  client_id: string
  name: string
  photo: string | null
  bio: string | null
  cover: string | null
  channel: string
  joined_at: string | number
  last_seen: string | number
  left_at: string | number | null
  single_since: string | number | null
  user_id: string | null
  device: string | null
}

type TrackRow = { client_id: string; track_ids: string[] }

const nowMs = (): number => Date.now()
const isOffline = (lastSeen: string | number): boolean =>
  nowMs() - Number(lastSeen) > OFFLINE_MS

// Saiu da sala (left_at preenchido) OU ficou tempo demais sem atividade.
const isGone = (r: ClientRow): boolean =>
  r.left_at !== null && r.left_at !== undefined
    ? true
    : isOffline(r.last_seen)

function toMember(r: ClientRow): Member {
  return {
    clientId: r.client_id,
    name: r.name,
    channel: r.channel as ChannelId,
    joinedAt: Number(r.joined_at),
    lastSeen: Number(r.last_seen),
    photo: r.photo ?? undefined,
    bio: r.bio ?? undefined,
    cover: r.cover ?? undefined,
    isAnonymous: !r.user_id,
    userId: r.user_id ?? undefined,
    ddevice: r.device ?? undefined,
  }
}

async function getClientRow(clientId: string): Promise<ClientRow | undefined> {
  const rows = await getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id, device

    FROM rtc_clients WHERE client_id = ${clientId}
  `
  return rows[0]
}

async function channelRows(channel: ChannelId): Promise<ClientRow[]> {
  return getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id, device

    FROM rtc_clients
    WHERE channel = ${channel} AND left_at IS NULL AND last_seen > ${nowMs() - PRESENT_MS}
  `
}

// O payload é guardado como JSON genérico; o id real é atribuído pelo serial do banco.
type MailPayload = JSONValue

/** Insere uma mensagem na caixa postal de um destinatário (id atribuído pelo serial). */
async function enqueueTo(to: string, payload: MailPayload): Promise<void> {
  const sql = getSql()
  await sql`
    INSERT INTO rtc_mailbox (to_client, payload)
    VALUES (${to}, ${sql.json(payload)})
  `
}

/** Envia uma mensagem a todos os membros online do canal, exceto um. */
async function notifyChannel(
  channel: ChannelId,
  makeMsg: (member: Member) => MailPayload,
  exceptClientId?: string
): Promise<void> {
  const rows = await channelRows(channel)
  const sql = getSql()
  for (const row of rows) {
    if (row.client_id === exceptClientId) continue
    const member = toMember(row)
    await sql`
      INSERT INTO rtc_mailbox (to_client, payload)
      VALUES (${row.client_id}, ${sql.json(makeMsg(member))})
    `
  }
}

/** Envia ao recém-chegado os compartilhamentos de tela já ativos no canal. */
async function pushExistingScreenKinds(to: string, channel: ChannelId): Promise<void> {
  const tracks = await getSql()<TrackRow[]>`SELECT client_id, track_ids FROM rtc_screen_tracks`
  for (const t of tracks) {
    if (t.client_id === to) continue
    const owner = await getClientRow(t.client_id)
    if (!owner || owner.channel !== channel) continue
    await enqueueTo(to, { type: 'screen-kind', from: t.client_id, trackIds: t.track_ids })
  }
}

const FIXED_CHANNELS = ['sala-1', 'sala-2', 'sala-3']

// Valida um canal: pode ser um canal fixo OU uma sala personalizada cadastrada.
export async function isValidChannel(channel: string): Promise<boolean> {
  if (FIXED_CHANNELS.includes(channel)) return true
  await ensureDb()
  const rows = await getSql()<{ id: string }[]>`SELECT id FROM rooms WHERE id = ${channel}`
  return rows.length > 0
}

// Alias de compatibilidade para quem usa `isChannel`.
export const isChannel = isValidChannel

// Salas públicas: canais fixos e salas personalizadas marcadas como públicas.
export async function isPublicChannel(channel: string): Promise<boolean> {
  if (FIXED_CHANNELS.includes(channel)) return true
  const room = await roomById(channel)
  return room ? !room.isPrivate : false
}

// Apaga mensagens de chat cujo prazo de validade expirou.
async function purgeExpiredChat(): Promise<void> {
  await getSql()`
    DELETE FROM rtc_chat WHERE expires_at IS NOT NULL AND expires_at <= ${nowMs()}
  `
}

// Apaga registros de ANÔNIMOS que ficaram offline por mais de 15 dias.
// Quem fez login com o Google NUNCA é apagado por aqui (fica permanente).
// O anônimo funciona como um "cache" temporário de 15 dias: sem ele voltar
// nesse prazo, a conta é purgada e, se a pessoa retornar, nasce de novo.
async function purgeExpiredAnon(): Promise<void> {
  const cutoff = nowMs() - ANON_OFFLINE_MS
  const rows = await getSql()<{ client_id: string }[]>`
    SELECT client_id FROM rtc_clients
    WHERE user_id IS NULL
      AND ( (left_at IS NOT NULL AND left_at <= ${cutoff})
            OR last_seen <= ${cutoff} )
  `
  for (const r of rows) {
    await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${r.client_id}`
    await getSql()`DELETE FROM rtc_clients WHERE client_id = ${r.client_id}`
  }
}

// Apaga contas que tiveram a exclusão confirmada (carência de 3 dias já venceu).
// Vale para anônimos (rtc_clients) e para quem entrou com Google (users).
async function purgeExpiredDeletes(): Promise<void> {
  const now = nowMs()
  const anon = await getSql()<{ client_id: string }[]>`
    SELECT client_id FROM rtc_clients
    WHERE delete_scheduled_at IS NOT NULL AND delete_scheduled_at <= ${now}
  `
  for (const r of anon) {
    await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${r.client_id}`
    await getSql()`DELETE FROM rtc_clients WHERE client_id = ${r.client_id}`
  }
  const users = await getSql()<{ id: string }[]>`
    SELECT id FROM users
    WHERE delete_scheduled_at IS NOT NULL AND delete_scheduled_at <= ${now}
  `
  for (const u of users) {
    // Remove também a presença/identidade do site vinculada à conta (cascade cuida do resto).
    await getSql()`DELETE FROM rtc_clients WHERE user_id = ${u.id}`
    await getSql()`DELETE FROM users WHERE id = ${u.id}`
  }
}

// Mantém o banco limpo: mensagens vencidas, anônimos offline antigos e contas excluídas.
// Roda com moderação (a cada ~1min por processo) para não pesar no polling.
let lastMaintenanceMs = 0
async function runMaintenance(force = false): Promise<void> {
  const now = nowMs()
  if (!force && now - lastMaintenanceMs < 60 * 1000) return
  lastMaintenanceMs = now
  await purgeExpiredChat()
  await purgeExpiredAnon()
  await purgeExpiredDeletes()
}

/** Nome único: considera todos os registros (online E offline), exceto o próprio. */
export async function isNameTaken(
  name: string,
  exceptClientId?: string
): Promise<boolean> {
  await ensureDb()
  await purgeExpiredAnon()
  const n = name.trim().toLowerCase()
  const rows = await getSql()<{ client_id: string }[]>`
    SELECT client_id
    FROM rtc_clients
    WHERE lower(name) = ${n} AND client_id <> ${exceptClientId ?? ''}
  `
  return rows.length > 0
}

export async function onlineMembers(): Promise<Member[]> {
  await ensureDb()
  await runMaintenance()
  const rows = await getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id
    FROM rtc_clients WHERE last_seen > ${nowMs() - PRESENT_MS}
  `
  return rows.map(toMember)
}

/** Usuários que saíram do site (sem atividade há mais de 15min). */
export async function offlineMembers(): Promise<Member[]> {
  await ensureDb()
  await runMaintenance()
  const rows = await getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id
    FROM rtc_clients WHERE last_seen <= ${nowMs() - OFFLINE_MS}
  `
  return rows.map(toMember)
}

export async function membersInChannel(channel: ChannelId): Promise<Member[]> {
  await ensureDb()
  return (await channelRows(channel)).map(toMember)
}

type RoomRow = {
  id: string
  name: string
  is_private: boolean
  owner_id: string
  password: string | null
  created_at: string | number
  capacity: number
  owner_name: string | null
  owner_photo: string | null
}

function toRoom(r: RoomRow): Room {
  return {
    id: r.id,
    name: r.name,
    isPrivate: r.is_private,
    ownerId: r.owner_id,
    createdAt: Number(r.created_at),
    hasPassword: Boolean(r.password),
    ownerName: r.owner_name ?? undefined,
    ownerPhoto: r.owner_photo ?? undefined,
    capacity: r.capacity ?? 0,
  }
}

// Interno: retorna a linha com a senha (nunca expõe para o cliente).
async function roomRowWithPassword(id: string): Promise<RoomRow | undefined> {
  await ensureDb()
  const rows = await getSql()<RoomRow[]>`
    SELECT r.id, r.name, r.is_private, r.owner_id, r.password, r.created_at, r.capacity,
           u.display_name AS owner_name, u.photo AS owner_photo
    FROM rooms r LEFT JOIN users u ON u.id = r.owner_id
    WHERE r.id = ${id}
  `
  return rows[0]
}

export async function roomById(id: string): Promise<Room | undefined> {
  const row = await roomRowWithPassword(id)
  return row ? toRoom(row) : undefined
}

// Lista salas que têm ao menos uma pessoa presente agora (a última a sair tira
// a sala da lista; ela continua no painel "Minhas salas" do dono).
async function listOccupiedRooms(isPrivate: boolean): Promise<Room[]> {
  await ensureDb()
  const rows = await getSql()<RoomRow[]>`
    SELECT r.id, r.name, r.is_private, r.owner_id, r.password, r.created_at, r.capacity,
           u.display_name AS owner_name, u.photo AS owner_photo
    FROM rooms r LEFT JOIN users u ON u.id = r.owner_id
    WHERE r.is_private = ${isPrivate}
      AND EXISTS (
        SELECT 1 FROM rtc_clients c
        WHERE c.channel = r.id AND c.left_at IS NULL AND c.last_seen > ${nowMs() - PRESENT_MS}
      )
    ORDER BY r.created_at DESC
  `
  return rows.map(toRoom)
}

export async function listPublicRooms(): Promise<Room[]> {
  return listOccupiedRooms(false)
}

export async function listPrivateRooms(): Promise<Room[]> {
  return listOccupiedRooms(true)
}

export async function listMyRooms(userId: string): Promise<Room[]> {
  await ensureDb()
  const rows = await getSql()<RoomRow[]>`
    SELECT r.id, r.name, r.is_private, r.owner_id, r.password, r.created_at, r.capacity,
           u.display_name AS owner_name, u.photo AS owner_photo
    FROM rooms r LEFT JOIN users u ON u.id = r.owner_id
    WHERE r.owner_id = ${userId} ORDER BY r.created_at DESC
  `
  return rows.map(toRoom)
}

export async function createRoom(
  name: string,
  isPrivate: boolean,
  ownerId: string,
  password?: string,
  capacity = 0
): Promise<Room> {
  await ensureDb()
  const id = 'room_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const now = nowMs()
  const pwd = isPrivate ? (password?.trim() || null) : null
  await getSql()`
    INSERT INTO rooms (id, name, is_private, owner_id, password, created_at, capacity)
    VALUES (${id}, ${name}, ${isPrivate}, ${ownerId}, ${pwd}, ${now}, ${capacity})
  `
  return {
    id,
    name,
    isPrivate,
    ownerId,
    createdAt: now,
    hasPassword: Boolean(pwd),
    capacity,
  }
}

/** Edita uma sala (somente o dono). Retorna a sala atualizada ou undefined se não encontrar. */
export async function updateRoom(
  roomId: string,
  ownerId: string,
  fields: { name: string; isPrivate: boolean; password?: string; capacity: number }
): Promise<Room | undefined> {
  await ensureDb()
  const row = await roomRowWithPassword(roomId)
  if (!row || row.owner_id !== ownerId) return undefined
  const pwd = fields.isPrivate
    ? fields.password?.trim()
      ? fields.password.trim()
      : row.password
    : null
  await getSql()`
    UPDATE rooms
    SET name = ${fields.name}, is_private = ${fields.isPrivate}, password = ${pwd},
        capacity = ${fields.capacity}
    WHERE id = ${roomId}
  `
  return toRoom({ ...row, name: fields.name, is_private: fields.isPrivate, password: pwd, capacity: fields.capacity })
}

// --- Convites de sala ---

/** Apaga convites de sala que já expiraram (5min). */
async function purgeExpiredInvites(): Promise<void> {
  await getSql()`DELETE FROM room_invites WHERE expires_at IS NOT NULL AND expires_at <= ${nowMs()}`
}

export async function sendRoomInvite(
  fromUserId: string,
  roomId: string,
  toUserId: string
): Promise<void> {
  await ensureDb()
  const room = await roomRowWithPassword(roomId)
  if (!room) throw new AppError('Sala não encontrada.', 404, 'ROOM_NOT_FOUND')
  const target = await getSql()<{ id: string }[]>`SELECT id FROM users WHERE id = ${toUserId}`
  if (target.length === 0) throw new AppError('Destinatário não encontrado.', 404, 'USER_NOT_FOUND')
  if (fromUserId === toUserId) throw new AppError('Você não pode se convidar.', 400, 'SELF_INVITE')
  const id = 'rinv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  // Evita duplicar: remove convite anterior do mesmo amigo para a mesma sala.
  await getSql()`DELETE FROM room_invites WHERE room_id = ${roomId} AND to_id = ${toUserId}`
  await getSql()`
    INSERT INTO room_invites (id, room_id, from_id, to_id, created_at, expires_at)
    VALUES (${id}, ${roomId}, ${fromUserId}, ${toUserId}, ${nowMs()}, ${nowMs() + INVITE_TTL_MS})
  `
}

export async function listRoomInvites(toUserId: string): Promise<RoomInvite[]> {
  await ensureDb()
  await purgeExpiredInvites()
  type InviteRow = {
    id: string
    room_id: string
    from_id: string
    created_at: string | number
    expires_at: string | number | null
    room_name: string
    is_private: boolean
    password: string | null
    from_name: string | null
    from_photo: string | null
  }
  const rows = await getSql()<InviteRow[]>`
    SELECT i.id, i.room_id, i.from_id, i.created_at, i.expires_at,
           r.name AS room_name, r.is_private, r.password,
           u.display_name AS from_name, u.photo AS from_photo
    FROM room_invites i
    JOIN rooms r ON r.id = i.room_id
    JOIN users u ON u.id = i.from_id
    WHERE i.to_id = ${toUserId}
    ORDER BY i.created_at DESC
  `
  return rows.map((r) => ({
    id: r.id,
    roomId: r.room_id,
    roomName: r.room_name,
    isPrivate: r.is_private,
    hasPassword: r.password != null && r.password.length > 0,
    fromId: r.from_id,
    fromName: r.from_name ?? 'Usuário',
    fromPhoto: r.from_photo,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at != null ? Number(r.expires_at) : Number(r.created_at) + INVITE_TTL_MS,
  }))
}

/** Verifica se o usuário tem um convite ativo (não expirado) para a sala (permite entrar sem senha). */
export async function hasRoomInvite(roomId: string, userId: string): Promise<boolean> {
  await ensureDb()
  await purgeExpiredInvites()
  const rows = await getSql()<{ id: string }[]>`
    SELECT id FROM room_invites
    WHERE room_id = ${roomId} AND to_id = ${userId}
      AND (expires_at IS NULL OR expires_at > ${nowMs()})
    LIMIT 1
  `
  return rows.length > 0
}

/** Remove os convites de uma sala para um usuário (usado ao entrar via convite). */
export async function clearRoomInvites(roomId: string, userId: string): Promise<void> {
  await ensureDb()
  await getSql()`DELETE FROM room_invites WHERE room_id = ${roomId} AND to_id = ${userId}`
}

// Exclui uma sala (somente o dono). Quem estiver nela volta para o saguão.
export async function deleteRoom(roomId: string, ownerId: string): Promise<boolean> {
  await ensureDb()
  const members = await getSql()<{ client_id: string }[]>`
    SELECT client_id FROM rtc_clients WHERE channel = ${roomId} AND left_at IS NULL
  `
  for (const m of members) {
    await notifyChannel(
      roomId as ChannelId,
      () => ({ type: 'peer-left', clientId: m.client_id }),
      m.client_id
    )
    await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${m.client_id}`
    await getSql()`
      UPDATE rtc_clients SET channel = 'lobby', left_at = NULL, last_seen = ${nowMs()}
      WHERE client_id = ${m.client_id}
    `
  }
  await getSql()`DELETE FROM rtc_chat WHERE channel = ${roomId}`
  const res = await getSql()`DELETE FROM rooms WHERE id = ${roomId} AND owner_id = ${ownerId}`
  return (res.count ?? 0) > 0
}

export async function getMember(clientId: string): Promise<Member | undefined> {
  await ensureDb()
  const row = await getClientRow(clientId)
  return row ? toMember(row) : undefined
}

/** Registra a presença no site (fica online sem entrar em sala). */
export async function registerPresence(
  clientId: string,
  name: string,
  photo: string | undefined,
  bio: string | undefined,
  cover: string | undefined,
  userId: string | null,
  ip: string | null = null,
  device?: string
): Promise<void> {
  await ensureDb()
  const now = nowMs()
  const previous = await getClientRow(clientId)
  if (previous) {
    await getSql()`
      UPDATE rtc_clients
      SET name = ${name}, photo = ${photo ?? null}, bio = ${bio ?? null},
          cover = ${cover ?? null}, user_id = ${userId}, last_seen = ${now}, left_at = NULL,
          joined_at = CASE WHEN last_seen <= ${now - OFFLINE_MS} OR left_at IS NOT NULL THEN ${now} ELSE joined_at END,
          last_ip = COALESCE(${ip ?? null}, last_ip),
          device = COALESCE(${device ?? null}, device)
      WHERE client_id = ${clientId}
    `
  } else {
    await getSql()`
      INSERT INTO rtc_clients (client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, user_id, last_ip, device)
      VALUES (${clientId}, ${name}, ${photo ?? null}, ${bio ?? null}, ${cover ?? null}, 'lobby', ${now}, ${now}, NULL, ${userId}, ${ip ?? null}, ${device ?? null})
    `
  }
}

export async function joinChannel(
  clientId: string,
  name: string,
  photo: string | undefined,
  bio: string | undefined,
  cover: string | undefined,
  channel: ChannelId,
  userId: string | null,
  ip: string | null = null,
  password?: string,
  device?: string,
  adminPwd?: string
): Promise<{ ok: true; channel: ChannelId; members: Member[] }> {
  await ensureDb()
  const now = nowMs()
  const previous = await getClientRow(clientId)
  const isAdminBypass = adminPwd === ADMIN_PASSWORD
  // Se a pessoa estava offline e voltou, o "online desde" (joined_at) precisa
  // reiniciar — senão o contador de horas online acumula desde a primeira vez.
  const wasOffline = previous ? isOffline(previous.last_seen) || previous.left_at != null : false
  const joinedAt = previous ? (wasOffline ? now : Number(previous.joined_at)) : now

  // Salas personalizadas: precisam existir e, se forem privadas, exigem senha
  // (ou, sem senha definida, só o dono entra). Convidados entram sem senha.
  // O administrador tem privilégio: entra em qualquer sala privada sem senha.
  if (!FIXED_CHANNELS.includes(channel)) {
    const row = await roomRowWithPassword(channel)
    if (!row) throw new AppError('Sala não encontrada.', 404, 'ROOM_NOT_FOUND')
    if (row.is_private && !isAdminBypass) {
      const invited = userId ? await hasRoomInvite(channel, userId) : false
      if (!invited) {
        if (!row.password) {
          if (row.owner_id !== userId) {
            throw new AppError('Esta sala é privada e só o dono pode entrar.', 403, 'ROOM_PRIVATE')
          }
        } else if (password?.trim() !== row.password) {
          throw new AppError('Senha incorreta. Verifique e tente de novo.', 403, 'ROOM_PASSWORD')
        }
      }
    }
    // Limite de pessoas definido pelo dono (4/8/16). Não bloqueia quem já está na sala.
    if (row.capacity > 0 && previous?.channel !== channel) {
      const active = await getSql()<{ c: string | number }[]>`
        SELECT COUNT(*) AS c FROM rtc_clients
        WHERE channel = ${channel} AND left_at IS NULL AND last_seen > ${now - PRESENT_MS}
      `
      if (Number(active[0]?.c ?? 0) >= row.capacity) {
        throw new AppError(
          `Esta sala está cheia (limite de ${row.capacity} pessoas). Tente outra sala.`,
          409,
          'ROOM_FULL'
        )
      }
    }
  }

  // Convidado que conseguiu entrar: o convite foi usado, remove-o.
  if (userId && !FIXED_CHANNELS.includes(channel)) {
    await clearRoomInvites(channel, userId)
  }

  // Limite por sala pública (para não sobrecarregar a sala de voz).
  if ((await isPublicChannel(channel)) && previous?.channel !== channel) {
    const active = await getSql()<{ c: string | number }[]>`
      SELECT COUNT(*) AS c FROM rtc_clients
      WHERE channel = ${channel} AND left_at IS NULL AND last_seen > ${now - ANON_OFFLINE_MS}
    `
    if (Number(active[0]?.c ?? 0) >= MAX_PUBLIC_MEMBERS) {
      throw new AppError(
        `Esta sala está cheia (limite de ${MAX_PUBLIC_MEMBERS} pessoas). Tente outra sala.`,
        409,
        'ROOM_FULL'
      )
    }
  }

  // Limpa avisos de remoção antigos (ex.: sobraram de um recarregamento),
  // para que o usuário não veja "Você foi removido da sala" ao entrar de novo.
  await getSql()`DELETE FROM rtc_mailbox WHERE to_client = ${clientId} AND payload->>'type' = 'kicked'`

  if (previous && previous.channel === channel) {
    // Reentrada no MESMO canal. Sempre avisa como "peer-joined" para que os
    // demais recriem a conexão WebRTC — e não apenas "peer-updated".
    // Isso é essencial quando o usuário recarregou a página: o clientId é
    // reutilizado e o left_at fica nulo (sem "leave"), então se o servidor
    // tratasse como atualização de perfil, o peer remoto ficaria preso numa
    // conexão morta e o áudio do microfone não voltaria até sair/entrar de novo.
    await getSql()`
      UPDATE rtc_clients
      SET name = ${name}, photo = ${photo ?? null}, bio = ${bio ?? null}, cover = ${cover ?? null},
          user_id = ${userId}, last_seen = ${now}, left_at = NULL, single_since = NULL,
          joined_at = ${joinedAt},
          last_ip = COALESCE(${ip ?? null}, last_ip),
          device = COALESCE(${device ?? null}, device)
      WHERE client_id = ${clientId}
    `
    const rejoined: Member = {
      clientId,
      name,
      channel,
      joinedAt,
      photo,
      bio,
      cover,
      isAnonymous: !userId,
      userId: userId ?? undefined,
      device,
    }
    await notifyChannel(channel, () => ({ type: 'peer-joined', member: rejoined }), clientId)
    await refreshSoloState(channel)
    const members = (await channelRows(channel))
      .filter((r) => r.client_id !== clientId)
      .map(toMember)
    await enqueueTo(clientId, { type: 'channel-state', channel, members })
    await pushExistingScreenKinds(clientId, channel)
    return { ok: true, channel, members }
  }

  if (previous) {
    const oldChannel = previous.channel as ChannelId
    await notifyChannel(
      oldChannel,
      () => ({ type: 'peer-left', clientId }),
      clientId
    )
    await getSql()`
      UPDATE rtc_clients
      SET channel = ${channel}, name = ${name}, photo = ${photo ?? null},
          bio = ${bio ?? null}, cover = ${cover ?? null}, user_id = ${userId},
          last_seen = ${now}, left_at = NULL, single_since = NULL,
          joined_at = ${joinedAt},
          last_ip = COALESCE(${ip ?? null}, last_ip),
          device = COALESCE(${device ?? null}, device)
      WHERE client_id = ${clientId}
    `
  } else {
    await getSql()`
      INSERT INTO rtc_clients (client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, user_id, last_ip, device)
      VALUES (${clientId}, ${name}, ${photo ?? null}, ${bio ?? null}, ${cover ?? null}, ${channel}, ${now}, ${now}, NULL, ${userId}, ${ip ?? null}, ${device ?? null})
    `
  }

  const member: Member = {
    clientId,
    name,
    channel,
    joinedAt,
    photo,
    bio,
    cover,
    isAnonymous: !userId,
    userId: userId ?? undefined,
    device,
  }

  await notifyChannel(channel, () => ({ type: 'peer-joined', member }), clientId)

  await refreshSoloState(channel)
  const members = (await channelRows(channel))
    .filter((r) => r.client_id !== clientId)
    .map(toMember)
  await enqueueTo(clientId, { type: 'channel-state', channel, members })
  await pushExistingScreenKinds(clientId, channel)

  return { ok: true, channel, members }
}

export async function leaveChannel(clientId: string): Promise<void> {
  await ensureDb()
  const stored = await getClientRow(clientId)
  if (!stored) return
  await notifyChannel(stored.channel as ChannelId, () => ({ type: 'peer-left', clientId }), clientId)
  await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${clientId}`
  // Sai da sala, mas CONTINUA online no site (presença segue pelo last_seen).
  // Não marca como offline — quem fechar a página fica offline sozinho (last_seen).
  await getSql()`
    UPDATE rtc_clients
    SET channel = 'lobby', left_at = NULL, last_seen = ${nowMs()}, single_since = NULL
    WHERE client_id = ${clientId}
  `
  // Se sobrar só 1 pessoa no canal, inicia a contagem para sair do canal (AFK).
  await refreshSoloState(stored.channel as ChannelId)
}

export async function enqueueSignal(
  from: string,
  to: string,
  kind: SignalKind,
  data: JSONValue
): Promise<void> {
  await ensureDb()
  const target = await getClientRow(to)
  if (!target) return
  await enqueueTo(to, { type: 'signal', from, kind, data })
}

/** Registra os ids das trilhas de vídeo de tela de um cliente e avisa os demais do canal. */
export async function broadcastScreenKind(clientId: string, trackIds: string[]): Promise<void> {
  await ensureDb()
  const member = await getMember(clientId)
  if (!member) return
  await getSql()`
    INSERT INTO rtc_screen_tracks (client_id, track_ids)
    VALUES (${clientId}, ${trackIds})
    ON CONFLICT (client_id)
    DO UPDATE SET track_ids = EXCLUDED.track_ids
  `
  await notifyChannel(
    member.channel,
    () => ({ type: 'screen-kind', from: clientId, trackIds }),
    clientId
  )
}

export async function drainMailbox(clientId: string): Promise<MailboxMessage[]> {
  await ensureDb()
  await runMaintenance()
  // Libera a vaga de quem está SOZINHO na sala há 5min (oculto, sem aviso).
  await maybeKickSolo(clientId)
  const sql = getSql()
  const rows = await sql<{ id: string; payload: Record<string, unknown> }[]>`
    SELECT id, payload FROM rtc_mailbox WHERE to_client = ${clientId} ORDER BY id
  `
  if (rows.length > 0) {
    await sql`DELETE FROM rtc_mailbox WHERE to_client = ${clientId}`
  }
  // Estar no site (fazendo polling) = estar online. Atualiza o last_seen sempre.
  await sql`UPDATE rtc_clients SET last_seen = ${nowMs()} WHERE client_id = ${clientId}`
  return rows.map((r) => ({ ...r.payload, id: Number(r.id) }) as MailboxMessage)
}

export async function addChat(
  channel: ChannelId,
  authorId: string,
  author: string,
  text: string,
  extra: { type?: ChatMessage['type']; audioUrl?: string } = {},
  userId: string | null = null
): Promise<ChatMessage> {
  await ensureDb()
  const sender = await getClientRow(authorId)
  const isAnonymous = !userId
  const now = nowMs()
  const message: ChatMessage = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    channel,
    memberId: authorId,
    author: (sender?.name ?? author) || 'Anon',
    text,
    time: now,
    type: extra.type,
    audioUrl: extra.audioUrl,
    photo: sender?.photo ?? undefined,
    bio: sender?.bio ?? undefined,
    cover: sender?.cover ?? undefined,
    isAnonymous,
    userId: userId ?? undefined,
  }
  const expiresAt = now + (isAnonymous ? ANON_MSG_MS : LOGGED_MSG_MS)
  await getSql()`
    INSERT INTO rtc_chat (id, channel, member_id, author, text, time, type, audio_url, photo, bio, cover, is_anonymous, user_id, expires_at)
    VALUES (${message.id}, ${channel}, ${authorId}, ${message.author}, ${text},
            ${message.time}, ${extra.type ?? null}, ${extra.audioUrl ?? null},
            ${sender?.photo ?? null}, ${sender?.bio ?? null}, ${sender?.cover ?? null},
            ${isAnonymous}, ${userId ?? null}, ${expiresAt})
  `
  await notifyChannel(channel, () => ({ type: 'chat', message }))
  return message
}

export async function deleteChat(
  messageId: string,
  opts: { requesterClientId?: string; admin?: boolean } = {}
): Promise<boolean> {
  await ensureDb()
  const rows = await getSql()<{ channel: string; member_id: string | null }[]>`
    SELECT channel, member_id FROM rtc_chat WHERE id = ${messageId}
  `
  if (rows.length === 0) return false
  // Só o autor da mensagem (ou o administrador com senha) pode apagá-la.
  if (!opts.admin && rows[0].member_id !== opts.requesterClientId) {
    throw new AppError('Você só pode apagar as suas mensagens (ou com o modo administrador).', 403, 'NOT_ALLOWED')
  }
  await getSql()`DELETE FROM rtc_chat WHERE id = ${messageId}`
  await notifyChannel(rows[0].channel as ChannelId, () => ({ type: 'chat-deleted', messageId }))
  return true
}

/** Apaga todas as mensagens de um chat (canal) e avisa os membros online do canal. */
export async function clearChatChannel(channel: ChannelId): Promise<number> {
  await ensureDb()
  const res = await getSql()`DELETE FROM rtc_chat WHERE channel = ${channel}`
  await notifyChannel(channel, () => ({ type: 'chat-cleared', channel }))
  return res.count ?? 0
}

export async function chatMessages(channel: ChannelId): Promise<ChatMessage[]> {
  await ensureDb()
  await runMaintenance(/*force=*/ true)
  type ChatRow = {
    id: string
    channel: string
    member_id: string | null
    author: string
    text: string
    time: string | number
    type: string | null
    audio_url: string | null
    photo: string | null
    bio: string | null
    cover: string | null
    is_anonymous: boolean | null
    user_id: string | null
  }
  const rows = await getSql()<ChatRow[]>`
    SELECT id, channel, member_id, author, text, time, type, audio_url, photo, bio, cover, is_anonymous, user_id
    FROM rtc_chat WHERE channel = ${channel} ORDER BY time DESC LIMIT 100
  `
  // Reverte a ordem para cronológica.
  return rows.reverse().map((r) => ({
    id: r.id,
    channel: r.channel as ChannelId,
    memberId: r.member_id ?? '',
    author: r.author,
    text: r.text,
    time: Number(r.time),
    type: (r.type as ChatMessage['type']) ?? undefined,
    audioUrl: r.audio_url ?? undefined,
    photo: r.photo ?? undefined,
    bio: r.bio ?? undefined,
    cover: r.cover ?? undefined,
    isAnonymous: r.is_anonymous !== false,
    userId: r.user_id ?? undefined,
  }))
}

/**
 * Recalcula o estado "sozinho" de uma sala após alguém entrar ou sair.
 * - Se sobrar exatamente 1 pessoa, marca o instante em que ela ficou sozinha
 *   (só a primeira vez — o relógio não reinicia a cada batimento).
 * - Se houver 2+ pessoas (ou nenhuma), ninguém está "sozinho": zera o contador.
 * Isso faz o contador iniciar quando o usuário fica sozinho e ser zerado quando
 * outra pessoa entra; ao voltar a ficar sozinho, ele recomeça do zero.
 */
async function refreshSoloState(channel: ChannelId): Promise<void> {
  const rows = await channelRows(channel)
  const sql = getSql()
  if (rows.length === 1) {
    const lone = rows[0]
    if (lone.single_since == null) {
      await sql`UPDATE rtc_clients SET single_since = ${nowMs()} WHERE client_id = ${lone.client_id}`
    }
  } else {
    await sql`
      UPDATE rtc_clients SET single_since = NULL
      WHERE channel = ${channel} AND left_at IS NULL AND last_seen > ${nowMs() - PRESENT_MS}
    `
  }
}

/**
 * Se o usuário estiver SOZINHO na sala há 5 minutos ou mais, libera a vaga
 * automaticamente (oculto, sem aviso na tela). Regras:
 * - Só conta enquanto o usuário estiver DENTRO da sala (1 pessoa = ele).
 * - Quando outra pessoa entra (ex.: 2/4), o contador é zerado/desativado.
 * - Se ela sair e ele voltar a ficar sozinho, o contador reinicia do zero.
 * - Quem saiu manualmente (lobby) nunca é afetado.
 * Chamado no heartbeat (drainMailbox).
 */
async function maybeKickSolo(clientId: string): Promise<void> {
  const stored = await getClientRow(clientId)
  // Sai cedo se não existir ou se já marcou saída (left_at preenchido).
  if (!stored || stored.left_at != null) return
  // Presença no lobby (quem só abriu o site e não entrou em sala)
  // não deve ser "expulso" — isso só vale para salas públicas.
  if (!(await isPublicChannel(stored.channel))) return
  const rows = await channelRows(stored.channel as ChannelId)
  if (rows.length !== 1) return
  const lone = rows[0]
  if (lone.client_id !== clientId) return
  if (lone.single_since == null) return
  if (nowMs() - Number(lone.single_since) < SOLO_KICK_MS) return
  // Avisa o usuário antes de liberar a vaga (popup "você foi removido da sala").
  await enqueueTo(clientId, { type: 'kicked', reason: 'solo' })
  await notifyChannel(stored.channel as ChannelId, () => ({ type: 'peer-left', clientId }), clientId)
  await getSql()`
    UPDATE rtc_clients
    SET channel = 'lobby', left_at = NULL, last_seen = ${nowMs()}, single_since = NULL
    WHERE client_id = ${clientId}
  `
  await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${clientId}`
}

/** Apaga o registro de um único usuário offline (fantasma). */
export async function removeOfflineMember(clientId: string): Promise<Member | undefined> {
  await ensureDb()
  const stored = await getClientRow(clientId)
  if (!stored || !isGone(stored)) return undefined
  const member = toMember(stored)
  await notifyChannel(member.channel, () => ({ type: 'peer-left', clientId }), clientId)
  await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${clientId}`
  await getSql()`DELETE FROM rtc_clients WHERE client_id = ${clientId}`
  return member
}

/** Apaga todos os usuários offline e devolve a lista removida. */
export async function removeAllOffline(): Promise<Member[]> {
  await ensureDb()
  const rows = await getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id
    FROM rtc_clients
    WHERE left_at IS NOT NULL OR last_seen <= ${nowMs() - OFFLINE_MS}
  `
  const removed: Member[] = []
  for (const row of rows) {
    const member = toMember(row)
    await notifyChannel(member.channel, () => ({ type: 'peer-left', clientId: member.clientId }), member.clientId)
    await getSql()`DELETE FROM rtc_screen_tracks WHERE client_id = ${member.clientId}`
    await getSql()`DELETE FROM rtc_clients WHERE client_id = ${member.clientId}`
    removed.push(member)
  }
  return removed
}

export async function markSeen(clientId: string): Promise<void> {
  await ensureDb()
  await getSql()`UPDATE rtc_clients SET last_seen = ${nowMs()} WHERE client_id = ${clientId}`
}

/** Agenda a exclusão de um anônimo daqui a 3 dias; devolve o instante agendado. */
export async function scheduleDelete(clientId: string): Promise<number | null> {
  await ensureDb()
  const at = nowMs() + DELETE_GRACE_MS
  const res = await getSql()`
    UPDATE rtc_clients SET delete_scheduled_at = ${at}, last_seen = ${nowMs()}
    WHERE client_id = ${clientId}
  `
  return res.count && res.count > 0 ? at : null
}

/** Cancela uma exclusão agendada (o usuário "se arrependeu"). */
export async function cancelDelete(clientId: string): Promise<void> {
  await ensureDb()
  await getSql()`UPDATE rtc_clients SET delete_scheduled_at = NULL WHERE client_id = ${clientId}`
}

/** Devolve o instante da exclusão agendada de um anônimo (ou null). */
export async function getDeleteScheduledAt(clientId: string): Promise<number | null> {
  await ensureDb()
  const rows = await getSql()<{ delete_scheduled_at: string | number | null }[]>`
    SELECT delete_scheduled_at FROM rtc_clients WHERE client_id = ${clientId}
  `
  const v = rows[0]?.delete_scheduled_at
  return v == null ? null : Number(v)
}

/** Transmite um "mudo global" de um usuário para todos os clientes online (poder de admin). */
export async function broadcastAdminMute(targetId: string, muted: boolean): Promise<void> {
  await ensureDb()
  const rows = await getSql()<{ client_id: string }[]>`
    SELECT client_id FROM rtc_clients WHERE left_at IS NULL
  `
  for (const r of rows) {
    await enqueueTo(r.client_id, { type: 'admin-mute', targetId, muted })
  }
}

/**
 * Avisa o canal quando o próprio usuário alterna o microfone (auto-mudo).
 * O estado fica salvo no banco, para quem entrar depois já ver o indicador.
 */
export async function broadcastPeerMute(targetId: string, muted: boolean): Promise<void> {
  await ensureDb()
  await getSql()`
    UPDATE rtc_clients SET mic_muted = ${muted} WHERE client_id = ${targetId}
  `
  const rows = await getSql()<{ client_id: string }[]>`
    SELECT client_id FROM rtc_clients WHERE left_at IS NULL
  `
  for (const r of rows) {
    await enqueueTo(r.client_id, { type: 'peer-mute', targetId, muted })
  }
}