'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { apiClient } from '@/lib/request'

// Bate-papo social entre amigos (estilo WhatsApp). Usa as rotas
// /api/social-chat (persistido no banco) e /api/social (lista de amigos).

type Peer = { id: string; name: string; photo: string | null }

type ConversationSummary = {
  id: string
  peer: Peer
  lastMessage: { text: string; time: number; fromMe: boolean } | null
  unread: number
}
type PendingSummary = { id: string; peer: Peer; lastMessage: { text: string; time: number } | null }
type ChatNotification = {
  id: string
  fromId: string
  fromName: string
  fromPhoto: string | null
  text: string
  createdAt: number
}
type ChatMessage = { id: string; fromMe: boolean; text: string; time: number }

const PRE_TEXT =
  'Oi, eu gostaria de ser seu amigo. Você poderia me aceitar? Se sim, aperte sim; se não, aperte não.'

function Avatar({ name, photo, size = 'h-12 w-12' }: { name: string; photo?: string | null; size?: string }) {
  return photo ? (
    <img src={photo} alt={name} className={`${size} shrink-0 rounded-full object-cover ring-2 ring-white/10`} />
  ) : (
    <span
      className={`${size} flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/40 to-fuchsia-500/40 text-lg font-bold text-white ring-2 ring-white/10`}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (days === 1) return 'ontem'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
}

export function SocialChat({
  me,
  onOpenProfile,
  focusSignal = 0,
}: {
  me: { id: string; name: string; photo?: string | null } | null
  onOpenProfile: (p: { userId: string; name: string; photo?: string | null }) => void
  focusSignal?: number
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [pending, setPending] = useState<PendingSummary[]>([])
  const [requests, setRequests] = useState<PendingSummary[]>([])
  const [notifications, setNotifications] = useState<ChatNotification[]>([])
  const [friends, setFriends] = useState<Peer[]>([])
  const [openConv, setOpenConv] = useState<ConversationSummary | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // pop-ups
  const [showPlus, setShowPlus] = useState(false)
  const [showBell, setShowBell] = useState(false)
  const [showNotif, setShowNotif] = useState(false)
  // tela de solicitação recebida
  const [review, setReview] = useState<PendingSummary | null>(null)

  const openConvRef = useRef<ConversationSummary | null>(null)
  openConvRef.current = openConv

  const loadSocial = useCallback(async () => {
    const [listRes, reqRes, friendsRes] = await Promise.all([
      apiClient.get<{ conversations: ConversationSummary[]; pending: PendingSummary[] }>('/api/social-chat?action=conversations'),
      apiClient.get<{ requests: PendingSummary[]; notifications: ChatNotification[] }>('/api/social-chat?action=requests'),
      apiClient.get<{ friends: Peer[] }>('/api/social'),
    ])
    if (listRes.success) {
      setConversations(listRes.data.conversations)
      setPending(listRes.data.pending)
    }
    if (reqRes.success) {
      setRequests(reqRes.data.requests)
      setNotifications(reqRes.data.notifications)
    }
    if (friendsRes.success) setFriends(friendsRes.data.friends)
  }, [])

  const loadMessages = useCallback(async (convId: string) => {
    const res = await apiClient.get<{ messages: ChatMessage[] }>('/api/social-chat?action=messages&conv=' + encodeURIComponent(convId))
    if (res.success) setMessages(res.data.messages)
  }, [])

  // Recarrega ao montar e a cada 5s (para refletir mensagens/solicitações novas).
  useEffect(() => {
    void loadSocial()
    const id = setInterval(() => {
      void loadSocial()
      const c = openConvRef.current
      if (c) void loadMessages(c.id)
    }, 5000)
    return () => clearInterval(id)
  }, [loadSocial, loadMessages])

  // Sinal externo (ex.: toque em "Ir" no aviso) → abre a lista do bate-papo social.
  useEffect(() => {
    if (focusSignal > 0) {
      setOpenConv(null)
      setShowPlus(false)
      setShowBell(false)
      setShowNotif(false)
      setReview(null)
    }
  }, [focusSignal])

  // Ao abrir uma conversa, carrega as mensagens e zera a não-lida.
  const openConversation = useCallback(
    (c: ConversationSummary) => {
      setOpenConv(c)
      setMessages([])
      void loadMessages(c.id)
      setConversations((prev) => prev.map((x) => (x.id === c.id ? { ...x, unread: 0 } : x)))
    },
    [loadMessages]
  )

  const sendRequest = useCallback(
    async (peer: Peer) => {
      const res = await apiClient.post<{ message: string }>('/api/social-chat', {
        action: 'send-request',
        toUserId: peer.id,
        text: PRE_TEXT,
      })
      if (!res.success) {
        toast.error(res.error || 'Não foi possível enviar.')
        return
      }
      toast.success(res.data?.message || 'Solicitação enviada!')
      setShowPlus(false)
      void loadSocial()
    },
    [loadSocial]
  )

  const sendMessage = useCallback(async () => {
    const c = openConv
    if (!c || !draft.trim() || sending) return
    setSending(true)
    const res = await apiClient.post<{ message: ChatMessage }>('/api/social-chat', {
      action: 'send-message',
      conversationId: c.id,
      text: draft,
    })
    setSending(false)
    if (!res.success) {
      toast.error(res.error || 'Não foi possível enviar.')
      return
    }
    setDraft('')
    setMessages((prev) => [...prev, res.data!.message])
    void loadSocial()
  }, [openConv, draft, sending, loadSocial])

  const acceptRequest = useCallback(
    async (convId: string) => {
      const res = await apiClient.post<{ message: string }>('/api/social-chat', { action: 'accept', conversationId: convId })
      if (!res.success) return toast.error(res.error || 'Não foi possível aceitar.')
      toast.success(res.data?.message || 'Agora vocês podem conversar!')
      setReview(null)
      setShowBell(false)
      void loadSocial()
    },
    [loadSocial]
  )

  const declineRequest = useCallback(
    async (convId: string) => {
      const res = await apiClient.post<{ message: string }>('/api/social-chat', { action: 'decline', conversationId: convId })
      if (!res.success) return toast.error(res.error || 'Não foi possível recusar.')
      toast.info(res.data?.message || 'Solicitação recusada.')
      setReview(null)
      setShowBell(false)
      void loadSocial()
    },
    [loadSocial]
  )

  const removeNotification = useCallback(
    async (id: string) => {
      await apiClient.post('/api/social-chat', { action: 'dismiss-notification', id })
      setNotifications((prev) => prev.filter((n) => n.id !== id))
    },
    []
  )

  // Aviso de nova mensagem (recusa) → "Enviar novamente" cria nova solicitação.
  const resendRequest = useCallback(
    async (fromId: string, id: string) => {
      const peer = notifications.find((n) => n.id === id) as ChatNotification | undefined
      await apiClient.post('/api/social-chat', { action: 'dismiss-notification', id })
      const res = await apiClient.post<{ message: string }>('/api/social-chat', {
        action: 'send-request',
        toUserId: fromId,
        text: PRE_TEXT,
      })
      if (!res.success) return toast.error(res.error || 'Não foi possível enviar novamente.')
      toast.success(peer ? `Solicitação reenviada para ${peer.fromName}.` : 'Solicitação reenviada!')
      void loadSocial()
    },
    [notifications, loadSocial]
  )

  const canGoBack = openConv || review

  return (
    <div className="relative flex h-full min-h-[26rem] flex-col overflow-hidden rounded-2xl share-panel-soft">
      {/* Cabeçalho */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5">
        {canGoBack ? (
          <button
            onClick={() => {
              setOpenConv(null)
              setReview(null)
              void loadSocial()
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 transition hover:bg-white/10"
            aria-label="Voltar"
          >
            ←
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
            <span className="text-base">💬</span> {me ? 'Bate-papo social' : 'Bate-papo social'}
          </div>
        )}
        <button
          onClick={() => setShowNotif((v) => !v)}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/5 text-slate-300 transition hover:bg-white/10"
          aria-label="Notificações"
          title="Notificações"
        >
          🔔
          {notifications.length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
              {notifications.length > 9 ? '+9' : notifications.length}
            </span>
          )}
        </button>
      </div>

      {/* Conteúdo */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!openConv && !review && (
          <div className="flex h-full flex-col">
            {/* Lista de conversas */}
            <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
              {/* Solicitações que enviei (Pendente) */}
              {pending.map((p) => (
                <div key={p.id} className="flex items-center gap-3 border-b border-white/5 px-3 py-3 opacity-80">
                  <Avatar name={p.peer.name} photo={p.peer.photo} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{p.peer.name}</span>
                      <span className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                        Pendente
                      </span>
                    </div>
                    <p className="truncate text-xs text-slate-400">{p.lastMessage?.text ?? '...'}</p>
                  </div>
                </div>
              ))}

              {conversations.length === 0 && pending.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                  <div className="text-4xl">🫂</div>
                  <p className="text-sm font-semibold text-slate-300">Nenhuma conversa ainda</p>
                  <p className="max-w-xs text-xs text-slate-400">
                    Toque no botão <b className="text-fuchsia-300">+</b> abaixo para chamar um amigo para conversar.
                  </p>
                </div>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openConversation(c)}
                    className="flex w-full items-center gap-3 border-b border-white/5 px-3 py-3 text-left transition hover:bg-white/5"
                  >
                    <Avatar name={c.peer.name} photo={c.peer.photo} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{c.peer.name}</span>
                        {c.lastMessage && (
                          <span className="shrink-0 text-[11px] text-slate-500">{fmtTime(c.lastMessage.time)}</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-xs text-slate-400">
                          {c.lastMessage
                            ? (c.lastMessage.fromMe ? 'Você: ' : '') + c.lastMessage.text
                            : 'Início da conversa'}
                        </p>
                        {c.unread > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-fuchsia-500 px-1.5 text-[11px] font-bold text-white">
                            {c.unread > 9 ? '+9' : c.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* Tela de conversa aberta */}
        {openConv && (
          <div className="flex h-full flex-col">
            {/* Cabeçalho da conversa */}
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2.5">
              <button
                onClick={() => openConversation({ ...openConv, unread: 0 })}
                className="rounded-lg text-slate-400 transition hover:text-white"
              >
                ←
              </button>
              <button
                onClick={() => onOpenProfile({ userId: openConv.peer.id, name: openConv.peer.name, photo: openConv.peer.photo })}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Avatar name={openConv.peer.name} photo={openConv.peer.photo} size="h-9 w-9" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold">{openConv.peer.name}</span>
                  <span className="block text-[11px] text-emerald-300/80">online agora</span>
                </span>
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
                aria-label="Mais opções"
                title="Mais opções"
              >
                ⋯
              </button>
            </div>

            {/* Mensagens */}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto no-scrollbar px-3 py-3">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  Diga oi! 👋
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex ${m.fromMe ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                        m.fromMe
                          ? 'rounded-br-md bg-fuchsia-600/80 text-white'
                          : 'rounded-bl-md bg-indigo-500/25 text-slate-100 ring-1 ring-indigo-400/20'
                      }`}
                    >
                      <p className="break-words whitespace-pre-wrap">{m.text}</p>
                      <p className={`mt-1 text-right text-[10px] ${m.fromMe ? 'text-white/60' : 'text-slate-400'}`}>
                        {fmtTime(m.time)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Entrada de mensagem */}
            <form
              className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-white/5 px-2 py-2"
              onSubmit={(e) => {
                e.preventDefault()
                void sendMessage()
              }}
            >
              <button
                type="button"
                title="Gravar mensagem de voz"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg text-slate-300 transition hover:bg-white/10"
              >
                🎤
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Mensagem"
                className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-800/60 px-3 text-sm outline-none focus:border-fuchsia-400/50"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="flex h-10 shrink-0 items-center justify-center rounded-xl bg-fuchsia-500 px-4 text-sm font-semibold text-white transition hover:bg-fuchsia-400 disabled:opacity-40"
              >
                ➤
              </button>
            </form>
          </div>
        )}

        {/* Tela de revisar solicitação recebida */}
        {review && (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            <Avatar name={review.peer.name} photo={review.peer.photo} size="h-16 w-16" />
            <div>
              <p className="text-sm font-bold">{review.peer.name}</p>
              <p className="text-xs text-slate-400">quer conversar com você</p>
            </div>
            <div className="w-full max-w-sm rounded-2xl bg-white/5 p-4 text-left text-sm text-slate-200 ring-1 ring-white/10">
              💬 {review.lastMessage?.text ?? PRE_TEXT}
            </div>
            <div className="flex w-full max-w-sm items-center gap-2">
              <button
                onClick={() => void declineRequest(review.id)}
                className="flex-1 rounded-xl bg-rose-500/20 py-2.5 text-sm font-semibold text-rose-200 ring-1 ring-rose-400/30 transition hover:bg-rose-500/30"
              >
                Recusar
              </button>
              <button
                onClick={() => void acceptRequest(review.id)}
                className="flex-1 rounded-xl bg-emerald-500 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-400"
              >
                Aceitar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Botão + flutuante (só na lista) */}
      {!openConv && !review && (
        <div className="pointer-events-none absolute bottom-4 right-3 flex flex-col items-end gap-2">
          <button
            onClick={() => setShowBell((v) => !v)}
            className="pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full bg-indigo-500/80 text-xl text-white shadow-lg shadow-black/40 ring-1 ring-white/10 transition hover:bg-indigo-400 active:scale-95"
            title="Solicitações"
            aria-label="Solicitações de conversa"
          >
            🔔
            {requests.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-white">
                {requests.length > 9 ? '+9' : requests.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowPlus((v) => !v)}
            className="pointer-events-auto relative flex h-12 w-12 items-center justify-center rounded-full bg-fuchsia-500 text-2xl text-white shadow-lg shadow-fuchsia-500/40 ring-1 ring-white/10 transition hover:bg-fuchsia-400 active:scale-95"
            title="Adicionar conversa"
            aria-label="Adicionar conversa"
          >
            +
          </button>
        </div>
      )}

      {/* Pop-up: adicionar conversa (+ de amigos) */}
      {showPlus && (
        <div className="absolute inset-0 z-20 flex flex-col bg-slate-950/90 backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
            <span className="text-sm font-semibold">Escolher amigo</span>
            <button onClick={() => setShowPlus(false)} className="rounded-lg px-2 py-1 text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
            {friends.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <div className="text-3xl">🤝</div>
                <p className="text-sm text-slate-400">Você ainda não tem amigos para chamar.</p>
              </div>
            ) : (
              friends.map((f) => (
                <div key={f.id} className="flex items-center gap-3 border-b border-white/5 px-3 py-3">
                  <Avatar name={f.name} photo={f.photo} size="h-10 w-10" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.name}</span>
                  <button
                    onClick={() => void sendRequest(f)}
                    className="shrink-0 rounded-lg bg-fuchsia-500/20 px-2.5 py-1.5 text-xs font-semibold text-fuchsia-200 ring-1 ring-fuchsia-400/30 transition hover:bg-fuchsia-500/30"
                  >
                    Mandar mensagem
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Pop-up: solicitações recebidas (sininho esquerda) */}
      {showBell && (
        <div className="absolute inset-0 z-20 flex flex-col bg-slate-950/90 backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
            <span className="text-sm font-semibold">Solicitações de conversa</span>
            <button onClick={() => setShowBell(false)} className="rounded-lg px-2 py-1 text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
            {requests.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <div className="text-3xl">📭</div>
                <p className="text-sm text-slate-400">Nenhuma solicitação de conversa.</p>
              </div>
            ) : (
              requests.map((r) => (
                <div key={r.id} className="flex items-center gap-3 border-b border-white/5 px-3 py-3">
                  <Avatar name={r.peer.name} photo={r.peer.photo} size="h-10 w-10" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{r.peer.name}</p>
                    <p className="truncate text-xs text-slate-400">{r.lastMessage?.text ?? '...'}</p>
                  </div>
                  <button
                    onClick={() => {
                      setShowBell(false)
                      setReview(r)
                    }}
                    className="shrink-0 rounded-lg bg-indigo-500/20 px-2.5 py-1.5 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/30"
                  >
                    Ver mensagem
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Pop-up: notificações (recusou sua mensagem) */}
      {showNotif && (
        <div className="absolute inset-0 z-20 flex flex-col bg-slate-950/90 backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
            <span className="text-sm font-semibold">Notificações</span>
            <button onClick={() => setShowNotif(false)} className="rounded-lg px-2 py-1 text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <div className="text-3xl">🔕</div>
                <p className="text-sm text-slate-400">Nenhuma notificação.</p>
              </div>
            ) : (
              notifications.map((n) => (
                <div key={n.id} className="flex items-start gap-3 border-b border-white/5 px-3 py-3">
                  <Avatar name={n.fromName} photo={n.fromPhoto} size="h-10 w-10" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{n.fromName}</p>
                    <p className="text-xs text-slate-400">{n.text}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      onClick={() => void resendRequest(n.fromId, n.id)}
                      className="rounded-lg bg-fuchsia-500/20 px-2 py-1 text-[11px] font-semibold text-fuchsia-200 ring-1 ring-fuchsia-400/30 transition hover:bg-fuchsia-500/30"
                    >
                      Enviar novamente
                    </button>
                    <button
                      onClick={() => void removeNotification(n.id)}
                      className="rounded-lg bg-white/5 px-2 py-1 text-[11px] text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10"
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
