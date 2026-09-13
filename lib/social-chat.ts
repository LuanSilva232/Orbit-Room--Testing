import 'server-only'

import { getSql } from '@/db'
import { AppError } from '@/lib/errors'

// Bate-papo social entre amigos: conversas 1:1 estilo WhatsApp, com
// solicitação de conversa, aceite/recusa e notificações de recusa.

type Peer = { id: string; name: string; photo: string | null }

export type ConversationSummary = {
  id: string
  peer: Peer
  lastMessage: { text: string; time: number; fromMe: boolean } | null
  unread: number
}

export type PendingSummary = {
  id: string
  peer: Peer
  lastMessage: { text: string; time: number } | null
}

export type ChatNotification = {
  id: string
  fromId: string
  fromName: string
  fromPhoto: string | null
  text: string
  createdAt: number
}

export type SocialChatMessage = { id: string; fromMe: boolean; text: string; time: number }

type ConvRow = {
  id: string
  user_a: string
  user_b: string
  status: string
  last_activity: string | number
}

async function peerFor(conv: { user_a: string; user_b: string }, meId: string): Promise<Peer> {
  const otherId = conv.user_a === meId ? conv.user_b : conv.user_a
  const rows = await getSql()<{ id: string; display_name: string; photo: string | null }[]>`
    SELECT id, display_name, photo FROM users WHERE id = ${otherId} AND status = 'active'
  `
  const u = rows[0]
  return { id: otherId, name: u?.display_name ?? 'Usuário', photo: u?.photo ?? null }
}

async function isFriend(meId: string, otherId: string): Promise<boolean> {
  const [r] = await getSql()`
    SELECT 1 FROM social_friends
    WHERE (user_a = ${meId} AND user_b = ${otherId}) OR (user_a = ${otherId} AND user_b = ${meId})
  `
  return Boolean(r)
}

async function lastMessage(convId: string): Promise<{ text: string; time: number; senderId: string } | null> {
  const rows = await getSql()<{ id: string; sender_id: string; text: string; time: string | number }[]>`
    SELECT id, sender_id, text, time FROM social_messages
    WHERE conversation_id = ${convId}
    ORDER BY time DESC LIMIT 1
  `
  const m = rows[0]
  return m ? { text: m.text, time: Number(m.time), senderId: m.sender_id } : null
}

async function unreadCount(convId: string, meId: string): Promise<number> {
  const rows = await getSql()<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM social_messages
    WHERE conversation_id = ${convId} AND sender_id <> ${meId} AND read = false
  `
  return Number(rows[0]?.n ?? 0)
}

// --- Listagens --------------------------------------------------------------

/** Conversas ativas (aceitas) — ordenadas pela última atividade (topo primeiro). */
export async function listConversations(meId: string): Promise<ConversationSummary[]> {
  const rows = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations
    WHERE (user_a = ${meId} OR user_b = ${meId}) AND status = 'active'
    ORDER BY last_activity DESC
  `
  const out: ConversationSummary[] = []
  for (const conv of rows) {
    const peer = await peerFor(conv, meId)
    const last = await lastMessage(conv.id)
    out.push({
      id: conv.id,
      peer,
      lastMessage: last ? { text: last.text, time: last.time, fromMe: last.senderId === meId } : null,
      unread: await unreadCount(conv.id, meId),
    })
  }
  return out
}

/** Solicitações que EU enviei e ainda aguardam aceite (mostradas com "Pendente"). */
export async function listPendingSent(meId: string): Promise<PendingSummary[]> {
  const rows = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations
    WHERE user_a = ${meId} AND status = 'pending'
    ORDER BY last_activity DESC
  `
  const out: PendingSummary[] = []
  for (const conv of rows) {
    const peer = await peerFor(conv, meId)
    const last = await lastMessage(conv.id)
    out.push({ id: conv.id, peer, lastMessage: last ? { text: last.text, time: last.time } : null })
  }
  return out
}

/** Solicitações que EU recebi e ainda posso aceitar ou recusar. */
export async function listRequestsReceived(meId: string): Promise<PendingSummary[]> {
  const rows = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations
    WHERE user_b = ${meId} AND status = 'pending'
    ORDER BY last_activity DESC
  `
  const out: PendingSummary[] = []
  for (const conv of rows) {
    const peer = await peerFor(conv, meId)
    const last = await lastMessage(conv.id)
    out.push({ id: conv.id, peer, lastMessage: last ? { text: last.text, time: last.time } : null })
  }
  return out
}

/** Notificações de "recusou sua mensagem" — chegadas para mim. */
export async function listNotifications(meId: string): Promise<ChatNotification[]> {
  const rows = await getSql()<{
    id: string
    from_id: string
    text: string
    created_at: string | number
    display_name: string
    photo: string | null
  }[]>`
    SELECT n.id, n.from_id, n.text, n.created_at, u.display_name, u.photo
    FROM social_chat_notifications n
    JOIN users u ON u.id = n.from_id
    WHERE n.user_id = ${meId}
    ORDER BY n.created_at DESC
    LIMIT 50
  `
  return rows.map((r) => ({
    id: r.id,
    fromId: r.from_id,
    fromName: r.display_name,
    fromPhoto: r.photo,
    text: r.text,
    createdAt: Number(r.created_at),
  }))
}

/** Mensagens de uma conversa — marca as recebidas como lidas. */
export async function getMessages(meId: string, convId: string): Promise<SocialChatMessage[]> {
  const [conv] = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations WHERE id = ${convId}
  `
  if (!conv) throw new AppError('Conversa não encontrada.', 404, 'CONV_NOT_FOUND')
  if (conv.user_a !== meId && conv.user_b !== meId)
    throw new AppError('Você não participa desta conversa.', 403, 'NOT_PARTICIPANT')

  await getSql()`
    UPDATE social_messages SET read = true
    WHERE conversation_id = ${convId} AND sender_id <> ${meId} AND read = false
  `

  const rows = await getSql()<{ id: string; sender_id: string; text: string; time: string | number }[]>`
    SELECT id, sender_id, text, time FROM social_messages
    WHERE conversation_id = ${convId}
    ORDER BY time ASC
  `
  return rows.map((m) => ({ id: m.id, fromMe: m.sender_id === meId, text: m.text, time: Number(m.time) }))
}

// --- Ações ------------------------------------------------------------------

/** Envia uma solicitação de conversa para um amigo (só amigos podem conversar). */
export async function sendConversationRequest(meId: string, toUserId: string, text: string): Promise<{ id: string }> {
  if (!toUserId) throw new AppError('Escolha um amigo.', 400, 'PEER_REQUIRED')
  if (toUserId === meId) throw new AppError('Você não pode conversar consigo mesmo.', 400, 'SELF_CHAT')
  if (!(await isFriend(meId, toUserId)))
    throw new AppError('Você só pode conversar com amigos.', 403, 'NOT_FRIENDS')

  // Já existe uma conversa ativa ou pendente (em QUALQUER direção)?
  // Antes só olhava (eu -> amigo); se o amigo já tinha pedido para mim,
  // criava uma segunda conversa duplicada. Bloqueia as duas direções.
  const [existing] = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations
    WHERE ((user_a = ${meId} AND user_b = ${toUserId}) OR (user_a = ${toUserId} AND user_b = ${meId}))
      AND status IN ('pending','active')
  `
  if (existing) throw new AppError('Você já tem uma conversa com este amigo.', 409, 'CONV_EXISTS')
  // Limpa conversas recusadas antigas do mesmo par (só ocupam espaço).
  await getSql()`
    DELETE FROM social_conversations
    WHERE ((user_a = ${meId} AND user_b = ${toUserId}) OR (user_a = ${toUserId} AND user_b = ${meId}))
      AND status = 'declined'
  `

  const now = Date.now()
  const id = `sc_${meId.slice(0, 6)}_${now}_${Math.floor(Math.random() * 1e6)}`
  await getSql()`
    INSERT INTO social_conversations (id, user_a, user_b, status, created_at, last_activity)
    VALUES (${id}, ${meId}, ${toUserId}, 'pending', ${now}, ${now})
  `
  const cleaned = text.trim() || 'Oi, gostaria de conversar com você!'
  await getSql()`
    INSERT INTO social_messages (id, conversation_id, sender_id, text, time, read)
    VALUES (${id + '_m0'}, ${id}, ${meId}, ${cleaned}, ${now}, true)
  `
  return { id }
}

/** Aceita uma solicitação de conversa recebida. */
export async function acceptConversationRequest(meId: string, convId: string): Promise<void> {
  const [conv] = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations WHERE id = ${convId}
  `
  if (!conv) throw new AppError('Solicitação não encontrada.', 404, 'REQ_NOT_FOUND')
  if (conv.user_b !== meId) throw new AppError('Esta solicitação não é para você.', 403, 'NOT_FOR_ME')
  if (conv.status !== 'pending') throw new AppError('Esta solicitação já foi respondida.', 409, 'ALREADY_ANSWERED')
  await getSql()`
    UPDATE social_conversations SET status = 'active', last_activity = ${Date.now()}
    WHERE id = ${convId}
  `
}

/** Recusa uma solicitação de conversa — some dos dois lados e avisa quem enviou. */
export async function declineConversationRequest(meId: string, convId: string): Promise<void> {
  const [conv] = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations WHERE id = ${convId}
  `
  if (!conv) throw new AppError('Solicitação não encontrada.', 404, 'REQ_NOT_FOUND')
  if (conv.user_b !== meId) throw new AppError('Esta solicitação não é para você.', 403, 'NOT_FOR_ME')
  if (conv.status !== 'pending') throw new AppError('Esta solicitação já foi respondida.', 409, 'ALREADY_ANSWERED')

  const now = Date.now()
  await getSql()`
    UPDATE social_conversations SET status = 'declined', declined_at = ${now}, last_activity = ${now}
    WHERE id = ${convId}
  `
  const [fromUser] = await getSql()<{ display_name: string }[]>`
    SELECT display_name FROM users WHERE id = ${meId} AND status = 'active'
  `
  await getSql()`
    INSERT INTO social_chat_notifications (id, user_id, from_id, text, created_at, read)
    VALUES (${'notif_' + now + '_' + Math.floor(Math.random() * 1e6)}, ${conv.user_a}, ${meId},
            ${(fromUser?.display_name ?? 'A pessoa') + ' recusou a sua mensagem.'}, ${now}, false)
  `
}

/** Envia uma mensagem numa conversa ativa. */
export async function sendConversationMessage(meId: string, convId: string, text: string): Promise<SocialChatMessage> {
  const cleaned = text.trim()
  if (!cleaned) throw new AppError('Mensagem vazia.', 400, 'EMPTY_MSG')

  const [conv] = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations WHERE id = ${convId}
  `
  if (!conv) throw new AppError('Conversa não encontrada.', 404, 'CONV_NOT_FOUND')
  if (conv.user_a !== meId && conv.user_b !== meId)
    throw new AppError('Você não participa desta conversa.', 403, 'NOT_PARTICIPANT')
  if (conv.status !== 'active')
    throw new AppError('Esta conversa ainda não foi aceita.', 409, 'NOT_ACTIVE')

  const now = Date.now()
  const id = `${convId}_m${now}_${Math.floor(Math.random() * 1e6)}`
  const toId = conv.user_a === meId ? conv.user_b : conv.user_a
  await getSql()`
    INSERT INTO social_messages (id, conversation_id, sender_id, text, time, read)
    VALUES (${id}, ${convId}, ${meId}, ${cleaned}, ${now}, false)
  `
  await getSql()`
    UPDATE social_conversations SET last_activity = ${now} WHERE id = ${convId}
  `
  // A mensagem chegou para o outro usuário → dispara o aviso "X mandou mensagem".
  await getSql()`
    INSERT INTO social_chat_notifications (id, user_id, from_id, text, created_at, read)
    VALUES (${'msg_' + now + '_' + Math.floor(Math.random() * 1e6)}, ${toId}, ${meId},
            ${'mandou mensagem.'}, ${now}, false)
  `
  return { id, fromMe: true, text: cleaned, time: now }
}

/** Remove uma notificação (ex.: recusa vista/excluída). */
export async function dismissNotification(meId: string, id: string): Promise<void> {
  await getSql()`
    DELETE FROM social_chat_notifications WHERE id = ${id} AND user_id = ${meId}
  `
}

/** Exclui uma conversa da minha visão (amigo remove o papo). */
export async function removeConversation(meId: string, convId: string): Promise<void> {
  const [conv] = await getSql()<ConvRow[]>`
    SELECT id, user_a, user_b, status, last_activity
    FROM social_conversations WHERE id = ${convId}
  `
  if (!conv) throw new AppError('Conversa não encontrada.', 404, 'CONV_NOT_FOUND')
  if (conv.user_a !== meId && conv.user_b !== meId)
    throw new AppError('Você não participa desta conversa.', 403, 'NOT_PARTICIPANT')
  // Marca como removida na direção de quem pediu (user_a remove → declina).
  await getSql()`DELETE FROM social_conversations WHERE id = ${convId}`
  await getSql()`DELETE FROM social_messages WHERE conversation_id = ${convId}`
}
