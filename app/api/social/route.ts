import { NextResponse } from 'next/server'

import { handleApiError } from '@/lib/api-error-response'
import { AppError, ValidationError, UnauthorizedError } from '@/lib/errors'
import * as store from '@/lib/rtc/store'
import type {
  ChannelId,
  ChatMessage,
  MailboxMessage,
  Member,
  SignalKind,
} from '@/lib/rtc/types'
import { getCurrentUser } from '@/lib/auth'
import * as social from '@/lib/social'

export const runtime = 'nodejs'

type RtPayload<T> = { success: true; data: T }

function ok<T>(data: T): NextResponse<RtPayload<T>> {
  return NextResponse.json({ success: true, data })
}

function readBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Corpo inválido')
  return body as Record<string, unknown>
}

const SOCIAL_ACTIONS = new Set([
  'send-request',
  'accept-request',
  'decline-request',
  'remove-friend',
  'follow',
  'unfollow',
])

// ---- GET: painel social (amigos/seguidores) ou rotas legadas de RTC --------
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const action = url.searchParams.get('action') ?? 'default'
    const clientId = url.searchParams.get('clientId') ?? ''

    if (action === 'mailbox') {
      const messages: MailboxMessage[] = clientId ? await store.drainMailbox(clientId) : []
      return ok<{
        messages: MailboxMessage[]
        members: Member[]
        offlineMembers: Member[]
      }>({
        messages,
        members: await store.onlineMembers(),
        offlineMembers: await store.offlineMembers(),
      })
    }

    if (action === 'sync') {
      if (!clientId) throw new ValidationError('clientId é obrigatório')
      const member = await store.getMember(clientId)
      const channel = (member?.channel ?? 'sala-1') as ChannelId
      const current = (await store.membersInChannel(channel)).filter(
        (m) => m.clientId !== clientId
      )
      return ok<{ channel: ChannelId; members: Member[] }>({ channel, members: current })
    }

    if (action === 'chat') {
      const channel = url.searchParams.get('channel') ?? 'sala-1'
      return ok<{ messages: ChatMessage[] }>({
        messages: await store.chatMessages(channel as ChannelId),
      })
    }

    // Padrão: painel de amigos do usuário logado.
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    return NextResponse.json(await social.getSocialOverview(user.id))
  } catch (error) {
    return handleApiError(error)
  }
}

// ---- POST: ações sociais ou rotas legadas de RTC ---------------------------
export async function POST(req: Request) {
  const body = readBody(await req.json())
  const action = body.action

  if (typeof action === 'string' && SOCIAL_ACTIONS.has(action)) {
    try {
      const user = await getCurrentUser()
      if (!user) {
        throw new UnauthorizedError('Faça login com o Google para usar os amigos.')
      }
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
      const msg = await handleSocialAction(action, user.id, body, str)
      return NextResponse.json({ ok: true, message: msg })
    } catch (error) {
      const appErr = error instanceof AppError ? error : undefined
      return NextResponse.json(
        { ok: false, message: appErr?.message ?? 'Não foi possível' },
        { status: appErr?.status ?? 400 }
      )
    }
  }

  try {
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''

    if (action === 'join') {
      const channel = typeof body.channel === 'string' ? body.channel : 'sala-1'
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const photo = typeof body.photo === 'string' ? body.photo : undefined
      const bio = typeof body.bio === 'string' ? body.bio : undefined
      const cover = typeof body.cover === 'string' ? body.cover : undefined
      const password = typeof body.password === 'string' ? body.password.trim() : ''
      if (!clientId) throw new ValidationError('clientId é obrigatório')
      if (!store.isChannel(channel)) throw new ValidationError('Canal inválido')
      const result = await store.joinChannel(
        clientId,
        name,
        photo,
        bio,
        cover,
        channel as ChannelId,
        null,
        null,
        password
      )
      return ok<{ channel: ChannelId; members: Member[] }>({
        channel: result.channel,
        members: result.members,
      })
    }

    if (action === 'leave') {
      if (!clientId) throw new ValidationError('clientId é obrigatório')
      await store.leaveChannel(clientId)
      return ok<{ left: boolean }>({ left: true })
    }

    if (action === 'signal') {
      const from = typeof body.from === 'string' ? body.from : ''
      const to = typeof body.to === 'string' ? body.to : ''
      const kind = body.kind as SignalKind
      if (!from || !to) throw new ValidationError('from/to são obrigatórios')
      if (!['offer', 'answer', 'ice'].includes(kind)) {
        throw new ValidationError('kind inválido')
      }
      await store.enqueueSignal(from, to, kind, body.data as import('postgres').JSONValue)
      return ok<{ queued: boolean }>({ queued: true })
    }

    if (action === 'screen-kind') {
      const trackIds = Array.isArray(body.trackIds)
        ? (body.trackIds as unknown[]).filter((t): t is string => typeof t === 'string')
        : []
      if (!clientId) throw new ValidationError('clientId é obrigatório')
      await store.broadcastScreenKind(clientId, trackIds)
      return ok<{ ok: boolean }>({ ok: true })
    }

    if (action === 'chat') {
      const channel = typeof body.channel === 'string' ? body.channel : 'sala-1'
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      const authorId = typeof body.authorId === 'string' ? body.authorId.trim() : ''
      const author = typeof body.author === 'string' ? body.author : ''
      const type = body.type === 'voice' ? 'voice' : undefined
      const audioUrl = typeof body.audioUrl === 'string' ? body.audioUrl : undefined
      if (!text) throw new ValidationError('Mensagem vazia')
      return ok<{ message: ChatMessage }>({
        message: await store.addChat(channel as ChannelId, authorId, author, text, {
          type,
          audioUrl,
        }),
      })
    }

     if (action === 'chat-delete') {
      const messageId = typeof body.messageId === 'string' ? body.messageId : ''
      const authorId = typeof body.authorId === 'string' ? body.authorId.trim() : ''
      const adminPwd = typeof body.adminPwd === 'string' ? body.adminPwd.trim() : ''
      if (!messageId) throw new ValidationError('messageId é obrigatório')
      return ok<{ deleted: boolean }>({
        deleted: await store.deleteChat(messageId, {
          requesterClientId: authorId || undefined,
          admin: adminPwd === store.ADMIN_PASSWORD,
        }),
      })
    }

    if (action === 'chat-clear') {
      const channel = typeof body.channel === 'string' ? body.channel : 'sala-1'
      const adminPwd = typeof body.adminPwd === 'string' ? body.adminPwd.trim() : ''
      if (!store.isChannel(channel)) throw new ValidationError('Canal inválido')
      if (adminPwd !== store.ADMIN_PASSWORD)
        throw new AppError('Só o administrador pode limpar o chat.', 403, 'ADMIN_REQUIRED')
      return ok<{ cleared: number }>({
        cleared: await store.clearChatChannel(channel as ChannelId),
      })
    }

    if (action === 'check-name') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const exceptClientId = typeof body.exceptClientId === 'string' ? body.exceptClientId : undefined
      if (!name) throw new ValidationError('name é obrigatório')
      return ok<{ available: boolean }>({
        available: !(await store.isNameTaken(name, exceptClientId)),
      })
    }

    if (action === 'remove-offline') {
      return ok<{ removed: Member[] }>({ removed: await store.removeAllOffline() })
    }

   if (action === 'remove-member') {
      const adminPwd = typeof body.adminPwd === 'string' ? body.adminPwd.trim() : ''
      if (!clientId) throw new ValidationError('clientId é obrigatório')
      if (adminPwd !== store.ADMIN_PASSWORD)
        throw new AppError('Só o administrador pode remover membros.', 403, 'ADMIN_REQUIRED')
      return ok<{ removed: Member | undefined }>({
        removed: await store.removeOfflineMember(clientId),
      })
    }

    if (action === 'admin-mute') {
      const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : ''
      const muted = body.muted === true
      const adminPwd = typeof body.adminPwd === 'string' ? body.adminPwd.trim() : ''
      if (!targetId) throw new ValidationError('targetId é obrigatório')
      if (adminPwd !== store.ADMIN_PASSWORD)
        throw new AppError('Só o administrador pode mutar participantes.', 403, 'ADMIN_REQUIRED')
      await store.broadcastAdminMute(targetId, muted)
      return ok<{ muted: boolean }>({ muted })
    }

    throw new ValidationError('Ação inválida')
  } catch (error) {
    return handleApiError(error)
  }
}

async function handleSocialAction(
  action: string,
  meId: string,
  body: Record<string, unknown>,
  str: (v: unknown) => string
): Promise<string> {
  const userId = str(body.userId)
  const fromUserId = str(body.fromUserId)
  const toUserId = str(body.toUserId)
  const toCode = str(body.toCode)

  switch (action) {
    case 'send-request': {
      await social.sendFriendRequest(meId, {
        userId: toUserId || undefined,
        toCode: toCode || undefined,
      })
      return 'Convite enviado!'
    }
    case 'accept-request': {
      if (!fromUserId) throw new ValidationError('fromUserId é obrigatório')
      await social.acceptFriendRequest(meId, fromUserId)
      return 'Agora vocês são amigos!'
    }
    case 'decline-request': {
      if (!fromUserId) throw new ValidationError('fromUserId é obrigatório')
      await social.declineFriendRequest(meId, fromUserId)
      return 'Convite recusado.'
    }
    case 'remove-friend': {
      if (!userId) throw new ValidationError('userId é obrigatório')
      await social.removeFriend(meId, userId)
      return 'Amizade encerrada.'
    }
    case 'follow': {
      if (!userId) throw new ValidationError('userId é obrigatório')
      await social.followUser(meId, userId)
      return 'Agora você segue esta pessoa.'
    }
    case 'unfollow': {
      if (!userId) throw new ValidationError('userId é obrigatório')
      await social.unfollowUser(meId, userId)
      return 'Você deixou de seguir.'
    }
  }
  throw new ValidationError('Ação inválida')
}
