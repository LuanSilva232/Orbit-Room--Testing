export type ChannelId = string

export type Member = {
  clientId: string
  name: string
  channel: ChannelId
  joinedAt: number
  lastSeen?: number
  photo?: string
  bio?: string
}

export type SignalKind = 'offer' | 'answer' | 'ice'

export type Profile = {
  name: string
  photo?: string
  bio?: string
}

export type ChatMessage = {
  id: string
  channel: ChannelId
  memberId: string
  author: string
  text: string
  time: number
  type?: 'text' | 'voice'
  audioUrl?: string
  photo?: string
  bio?: string
}

export type Quality = 'auto' | 'baixa' | 'media' | 'alta'

export const QUALITY_OPTIONS: { id: Quality; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'deixa o ShareRoom decidir' },
  { id: 'baixa', label: 'Baixa', hint: 'prioriza fluidez' },
  { id: 'media', label: 'Média', hint: 'equilíbrio' },
  { id: 'alta', label: 'Alta', hint: 'prioriza nitidez' },
]

export const DEFAULT_CHANNELS: { id: ChannelId; label: string; description: string }[] = [
  { id: 'geral', label: 'Geral', description: 'voz para todos' },
  { id: 'sala-1', label: 'Sala 1', description: 'voz livre' },
  { id: 'sala-2', label: 'Sala 2', description: 'voz livre' },
  { id: 'sala-3', label: 'Sala 3', description: 'voz livre' },
]

export function channelLabel(channel: ChannelId): string {
  const found = DEFAULT_CHANNELS.find((c) => c.id === channel)
  return found?.label ?? channel
}

/** Estado de caixa postal / sinalização. */
export type MailboxMessage =
  | { id: number; type: 'signal'; from: string; kind: SignalKind; data: unknown }
  | { id: number; type: 'peer-joined'; member: Member }
  | { id: number; type: 'peer-left'; clientId: string }
  | { id: number; type: 'peer-updated'; member: Member }
  | { id: number; type: 'channel-state'; channel: ChannelId; members: Member[] }
  | { id: number; type: 'chat'; message: ChatMessage }
  | { id: number; type: 'chat-deleted'; messageId: string }
  | { id: number; type: 'screen-kind'; from: string; trackIds: string[] }
  | { id: number; type: 'admin-mute'; targetId: string; muted: boolean }