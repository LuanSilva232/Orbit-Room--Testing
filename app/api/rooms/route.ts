import { NextResponse } from 'next/server'

import { handleApiError } from '@/lib/api-error-response'
import { AppError, ValidationError } from '@/lib/errors'
import { getCurrentUser } from '@/lib/auth'
import type { Room } from '@/lib/rtc/types'
import * as store from '@/lib/rtc/store'

export const runtime = 'nodejs'

// GET /api/rooms            -> salas públicas (ocupadas)
// GET /api/rooms?mine=1     -> salas do usuário logado
// GET /api/rooms?private=1  -> salas privadas (ocupadas)
// GET /api/rooms?invites=1  -> convites de sala do usuário logado
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const mine = url.searchParams.get('mine') === '1'
    const priv = url.searchParams.get('private') === '1'
    const invites = url.searchParams.get('invites') === '1'
    if (mine || priv || invites) {
      const user = await getCurrentUser()
      if (!user) throw new AppError('Faça login para ver suas salas.', 401, 'UNAUTHORIZED')
      if (mine) {
        const rooms: Room[] = await store.listMyRooms(user.id)
        return NextResponse.json({ success: true, data: { rooms } })
      }
      if (priv) {
        const rooms: Room[] = await store.listPrivateRooms()
        return NextResponse.json({ success: true, data: { rooms } })
      }
      const roomInvites = await store.listRoomInvites(user.id)
      return NextResponse.json({ success: true, data: { roomInvites } })
    }
    const rooms: Room[] = await store.listPublicRooms()
    return NextResponse.json({ success: true, data: { rooms } })
  } catch (error) {
    return handleApiError(error)
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new AppError('Faça login para criar uma sala.', 401, 'UNAUTHORIZED')
    const body = await req.json()
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const isPrivate = body?.isPrivate === true
    const password = typeof body?.password === 'string' ? body.password.trim() : ''
    const capacity = normalizeCapacity(body?.capacity)
    if (!name) throw new ValidationError('Digite um nome para a sala.')
    if (name.length > 30) throw new ValidationError('O nome da sala pode ter no máximo 30 caracteres.')
    if (isPrivate && !password) {
      throw new ValidationError('Salas privadas precisam de uma senha.')
    }
    if (password && password.length > 30) {
      throw new ValidationError('A senha pode ter no máximo 30 caracteres.')
    }
    const room: Room = await store.createRoom(name, isPrivate, user.id, password || undefined, capacity)
    return NextResponse.json({ success: true, data: { room } })
  } catch (error) {
    return handleApiError(error)
  }
}

function normalizeCapacity(v: unknown): number {
  if (typeof v === 'number') return [4, 8, 16].includes(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return [4, 8, 16].includes(n) ? n : 0
  }
  return 0
}

export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new AppError('Faça login para editar uma sala.', 401, 'UNAUTHORIZED')
    const body = await req.json()
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) throw new ValidationError('id é obrigatório')
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) throw new ValidationError('Digite um nome para a sala.')
    if (name.length > 30) throw new ValidationError('O nome da sala pode ter no máximo 30 caracteres.')
    const isPrivate = body?.isPrivate === true
    const password = typeof body?.password === 'string' ? body.password.trim() : ''
    if (password && password.length > 30) {
      throw new ValidationError('A senha pode ter no máximo 30 caracteres.')
    }
    const capacity = normalizeCapacity(body?.capacity)
    const room = await store.updateRoom(id, user.id, { name, isPrivate, password, capacity })
    if (!room) throw new AppError('Sala não encontrada ou sem permissão.', 404, 'ROOM_NOT_FOUND')
    return NextResponse.json({ success: true, data: { room } })
  } catch (error) {
    return handleApiError(error)
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new AppError('Faça login para excluir uma sala.', 401, 'UNAUTHORIZED')
    const url = new URL(req.url)
    const id = url.searchParams.get('id') ?? ''
    if (!id) throw new ValidationError('id é obrigatório')
    const ok = await store.deleteRoom(id, user.id)
    if (!ok) throw new AppError('Sala não encontrada ou sem permissão.', 404, 'ROOM_NOT_FOUND')
    return NextResponse.json({ success: true, data: { ok } })
  } catch (error) {
    return handleApiError(error)
  }
}
