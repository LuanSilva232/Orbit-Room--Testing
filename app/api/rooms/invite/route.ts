import { NextResponse } from 'next/server'

import { handleApiError } from '@/lib/api-error-response'
import { AppError, ValidationError } from '@/lib/errors'
import { getCurrentUser } from '@/lib/auth'
import * as store from '@/lib/rtc/store'

export const runtime = 'nodejs'

// POST /api/rooms/invite  { roomId, toUserId } -> envia um convite de sala
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new AppError('Faça login para convidar.', 401, 'UNAUTHORIZED')
    const body = await req.json()
    const roomId = typeof body?.roomId === 'string' ? body.roomId.trim() : ''
    const toUserId = typeof body?.toUserId === 'string' ? body.toUserId.trim() : ''
    if (!roomId) throw new ValidationError('Sala não informada.')
    if (!toUserId) throw new ValidationError('Escolha um amigo para convidar.')
    await store.sendRoomInvite(user.id, roomId, toUserId)
    return NextResponse.json({ success: true, data: { ok: true } })
  } catch (error) {
    return handleApiError(error)
  }
}

// DELETE /api/rooms/invite?roomId=... -> remove os convites dessa sala (recusar/limpar)
export async function DELETE(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new AppError('Faça login.', 401, 'UNAUTHORIZED')
    const url = new URL(req.url)
    const roomId = url.searchParams.get('roomId') ?? ''
    if (!roomId) throw new ValidationError('roomId é obrigatório')
    await store.clearRoomInvites(roomId, user.id)
    return NextResponse.json({ success: true, data: { ok: true } })
  } catch (error) {
    return handleApiError(error)
  }
}
