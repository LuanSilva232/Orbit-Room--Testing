import 'server-only'

import type { JSONValue } from 'postgres'
import type {
  ChannelId,
  ChatMessage,
  MailboxMessage,
  Member,
  SignalKind,
} from './types'
import { ensureDb, getSql } from '@/db'

// Estado da sala (presença, sinalização, chat e compartilhamento de tela)
// persistido no banco em nuvem. Isso permite funcionar em hospedagens
// serverless (Vercel), onde cada requisição pode cair numa instância diferente
// e o estado precisa ser compartilhado/centralizado.
export const OFFLINE_MS = 15 * 60 * 1000 // 15min sem atividade = offline
export const SOLO_KICK_MS = 5 * 60 * 1000 // 5min sozinho no canal = sai do canal automaticamente
export const ANON_MSG_MS = 24 * 60 * 60 * 1000 // mensagens de anônimos somem após 24h
export const LOGGED_MSG_MS = 48 * 60 * 60 * 1000 // mensagens de contas logadas somem após 48h
export const ANON_OFFLINE_MS = 15 * 60 * 1000 // anônimo offline é apagado após 15min

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
  }
}

async function getClientRow(clientId: string): Promise<ClientRow | undefined> {
  const rows = await getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id
    FROM rtc_clients WHERE client_id = ${clientId}
  `
  return rows[0]
}

async function channelRows(channel: ChannelId): Promise<ClientRow[]> {
  return getSql()<ClientRow[]>`
    SELECT client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, single_since, user_id
    FROM rtc_clients
    WHERE channel = ${channel} AND left_at IS NULL AND last_seen > ${nowMs() - OFFLINE_MS}
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

export function isChannel(channel: string): boolean {
  return ['geral', 'sala-1', 'sala-2', 'sala-3'].includes(channel)
}

// Apaga mensagens de chat cujo prazo de validade expirou.
async function purgeExpiredChat(): Promise<void> {
  await getSql()`
    DELETE FROM rtc_chat WHERE expires_at IS NOT NULL AND expires_at <= ${nowMs()}
  `
}

// Apaga registros de ANÔNIMOS que ficaram offline por mais de 15min.
// Quem fez login com o Google NUNCA é apagado por aqui (fica permanente).
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

// Mantém o banco limpo: mensagens vencidas e anônimos offline antigos.
// Roda com moderação (a cada ~1min por processo) para não pesar no polling.
let lastMaintenanceMs = 0
async function runMaintenance(force = false): Promise<void> {
  const now = nowMs()
  if (!force && now - lastMaintenanceMs < 60 * 1000) return
  lastMaintenanceMs = now
  await purgeExpiredChat()
  await purgeExpiredAnon()
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
    FROM rtc_clients WHERE last_seen > ${nowMs() - OFFLINE_MS}
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
  userId: string | null
): Promise<void> {
  await ensureDb()
  const now = nowMs()
  const previous = await getClientRow(clientId)
  if (previous) {
    await getSql()`
      UPDATE rtc_clients
      SET name = ${name}, photo = ${photo ?? null}, bio = ${bio ?? null},
          cover = ${cover ?? null}, user_id = ${userId}, last_seen = ${now}, left_at = NULL
      WHERE client_id = ${clientId}
    `
  } else {
    await getSql()`
      INSERT INTO rtc_clients (client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, user_id)
      VALUES (${clientId}, ${name}, ${photo ?? null}, ${bio ?? null}, ${cover ?? null}, 'geral', ${now}, ${now}, NULL, ${userId})
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
  userId: string | null
): Promise<{ ok: true; channel: ChannelId; members: Member[] }> {
  await ensureDb()
  const now = nowMs()
  const previous = await getClientRow(clientId)

  if (previous && previous.channel === channel) {
    // Reentrada no MESMO canal. Se o usuário tinha saído (left_at preenchido),
    // é uma nova entrada de fato: avisa os demais como peer-joined para que
    // recriem a conexão WebRTC. Caso contrário, é só atualização de perfil.
    const wasAway = previous.left_at !== null && previous.left_at !== undefined
    await getSql()`
      UPDATE rtc_clients
      SET name = ${name}, photo = ${photo ?? null}, bio = ${bio ?? null}, cover = ${cover ?? null},
          user_id = ${userId}, last_seen = ${now}, left_at = NULL
      WHERE client_id = ${clientId}
    `
    if (wasAway) {
      const rejoined: Member = {
        clientId,
        name,
        channel,
        joinedAt: Number(previous.joined_at),
        photo,
        bio,
        cover,
        isAnonymous: !userId,
      }
      await notifyChannel(channel, () => ({ type: 'peer-joined', member: rejoined }), clientId)
    } else {
      await notifyChannel(channel, (m) => ({ type: 'peer-updated', member: m }), clientId)
    }
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
          last_seen = ${now}, left_at = NULL
      WHERE client_id = ${clientId}
    `
  } else {
    await getSql()`
      INSERT INTO rtc_clients (client_id, name, photo, bio, cover, channel, joined_at, last_seen, left_at, user_id)
      VALUES (${clientId}, ${name}, ${photo ?? null}, ${bio ?? null}, ${cover ?? null}, ${channel}, ${now}, ${now}, NULL, ${userId})
    `
  }

  const member: Member = {
    clientId,
    name,
    channel,
    joinedAt: previous ? Number(previous.joined_at) : now,
    photo,
    bio,
    cover,
    isAnonymous: !userId,
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
    SET channel = 'geral', left_at = NULL, last_seen = ${nowMs()}
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
  // Se estiver sozinho há 5min+, sai do canal automaticamente (o aviso entra na caixa).
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
  }
  const expiresAt = now + (isAnonymous ? ANON_MSG_MS : LOGGED_MSG_MS)
  await getSql()`
    INSERT INTO rtc_chat (id, channel, member_id, author, text, time, type, audio_url, photo, bio, cover, is_anonymous, expires_at)
    VALUES (${message.id}, ${channel}, ${authorId}, ${message.author}, ${text},
            ${message.time}, ${extra.type ?? null}, ${extra.audioUrl ?? null},
            ${sender?.photo ?? null}, ${sender?.bio ?? null}, ${sender?.cover ?? null},
            ${isAnonymous}, ${expiresAt})
  `
  await notifyChannel(channel, () => ({ type: 'chat', message }))
  return message
}

export async function deleteChat(messageId: string): Promise<boolean> {
  await ensureDb()
  const rows = await getSql()<{ channel: string }[]>`SELECT channel FROM rtc_chat WHERE id = ${messageId}`
  if (rows.length === 0) return false
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
  }
  const rows = await getSql()<ChatRow[]>`
    SELECT id, channel, member_id, author, text, time, type, audio_url, photo, bio, cover, is_anonymous
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
  }))
}

/**
 * Recalcula o estado "sozinho" de um canal após alguém entrar ou sair.
 * - Se sobrar exatamente 1 pessoa, marca o instante em que ela ficou sozinha
 *   (apenas na primeira vez — o relógio não reinicia a cada heartbeat).
 * - Se houver 2+ pessoas (ou nenhuma), ninguém está "sozinho".
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
      WHERE channel = ${channel} AND left_at IS NULL AND last_seen > ${nowMs() - OFFLINE_MS}
    `
  }
}

/**
 * Se o usuário estiver SOZINHO no canal há 5 minutos ou mais, desconecta-o
 * automaticamente (AFK) e o avisa. Chamado no heartbeat (drainMailbox).
 */
async function maybeKickSolo(clientId: string): Promise<void> {
  const stored = await getClientRow(clientId)
  if (!stored || stored.left_at !== null || stored.left_at !== undefined) return
  const rows = await channelRows(stored.channel as ChannelId)
  if (rows.length !== 1) return
  const lone = rows[0]
  if (lone.client_id !== clientId) return
  if (lone.single_since == null) return
  if (nowMs() - Number(lone.single_since) < SOLO_KICK_MS) return
  // Avisa antes de sair do canal para o próprio usuário entender o motivo.
  await enqueueTo(clientId, { type: 'kicked', reason: 'solo' })
  await notifyChannel(stored.channel as ChannelId, () => ({ type: 'peer-left', clientId }), clientId)
  await getSql()`
    UPDATE rtc_clients
    SET channel = 'geral', left_at = NULL, last_seen = ${nowMs()}, single_since = NULL
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
