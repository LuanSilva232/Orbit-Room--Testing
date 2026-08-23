import { NextResponse } from 'next/server'

import { getCurrentUser } from '@/lib/auth'
import { AppError, UnauthorizedError, ValidationError } from '@/lib/errors'
import * as sc from '@/lib/social-chat'

export const runtime = 'nodejs'

// Bate-papo social entre amigos (só para quem fez login com o Google).
// As mensagens e conversas são persistidas no banco em nuvem.

function ok<T>(data: T) {
  return NextResponse.json({ success: true, data })
}

function body(req: Request): Promise<Record<string, unknown>> {
  return req.json().then((b) => (b && typeof b === 'object' ? b : {}) as Record<string, unknown>)
}

async function requireUser() {
  const user = await getCurrentUser()
  if (!user) throw new UnauthorizedError('Faça login com o Google para usar o bate-papo.')
  return user
}

export async function GET(req: Request) {
  try {
    const user = await requireUser()
    const url = new URL(req.url)
    const action = url.searchParams.get('action') ?? 'conversations'

    if (action === 'conversations')
      return ok({ conversations: await sc.listConversations(user.id), pending: await sc.listPendingSent(user.id) })
    if (action === 'requests')
      return ok({ requests: await sc.listRequestsReceived(user.id), notifications: await sc.listNotifications(user.id) })
    if (action === 'messages') {
      const conv = url.searchParams.get('conv') ?? ''
      if (!conv) throw new ValidationError('conv é obrigatório')
      return ok({ messages: await sc.getMessages(user.id, conv) })
    }
    throw new ValidationError('Ação inválida')
  } catch (error) {
    return toError(error)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const b = await body(req)
    const action = b.action
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

    if (action === 'send-request') {
      const toUserId = str(b.toUserId)
      const text = str(b.text)
      const res = await sc.sendConversationRequest(user.id, toUserId, text)
      return ok({ conversationId: res.id, message: 'Solicitação enviada!' })
    }
    if (action === 'accept') {
      await sc.acceptConversationRequest(user.id, str(b.conversationId))
      return ok({ message: 'Agora vocês podem conversar!' })
    }
    if (action === 'decline') {
      await sc.declineConversationRequest(user.id, str(b.conversationId))
      return ok({ message: 'Solicitação recusada.' })
    }
    if (action === 'send-message') {
      const msg = await sc.sendConversationMessage(user.id, str(b.conversationId), str(b.text))
      return ok({ message: msg })
    }
    if (action === 'dismiss-notification') {
      await sc.dismissNotification(user.id, str(b.id))
      return ok({ message: 'Removido.' })
    }
    if (action === 'remove-conversation') {
      await sc.removeConversation(user.id, str(b.conversationId))
      return ok({ message: 'Conversa removida.' })
    }
    throw new ValidationError('Ação inválida')
  } catch (error) {
    return toError(error)
  }
}

function toError(error: unknown) {
  const appErr = error instanceof AppError ? error : undefined
  if (appErr) return NextResponse.json({ success: false, error: appErr.message }, { status: appErr.status })
  const status = error instanceof Error && 'status' in error ? Number((error as { status?: number }).status) : 500
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : 'Erro interno' },
    { status: Number.isFinite(status) && status >= 400 ? status : 500 }
  )
}
