'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FriendMoreMenu } from './friend-actions'

export type OpenProfileFn = (u: {
  userId: string
  name: string
  photo?: string | null
  bio?: string | null
  cover?: string | null
}) => void

type Friend = {
  id: string
  name: string
  photo?: string | null
  cover?: string | null
  bio?: string | null
  code?: string | null
  online: boolean
  channelId: string | null
}

type RequestItem = {
  requestId: string
  fromId: string
  createdAt: number
  displayName: string
  photo?: string | null
  code?: string | null
}

type SocialData = {
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
  friends: Friend[]
  requests: RequestItem[]
  followers: { id: string; displayName: string; photo?: string | null }[]
  following: { id: string; displayName: string; photo?: string | null }[]
}

const post = (body: { action: string; [k: string]: unknown }) =>
  fetch('/api/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ ok: false, message: 'Falha de rede' }))

const Avatar = ({ name, photo, size = 40 }: { name?: string; photo?: string | null; size?: number }) => (
  photo ? (
    <img
      src={photo}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full object-cover"
    />
  ) : (
    <div
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 font-bold text-white shadow-inner"
    >
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  )
)

function StatCard({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-white/5 bg-gradient-to-b from-white/10 to-white/[0.02] px-2 py-3">
      <span className="text-base leading-none">{icon}</span>
      <div className="text-xl font-extrabold text-white tabular-nums">{value}</div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">{label}</div>
    </div>
  )
}

function Aba({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-colors duration-100 ${
        active
          ? 'bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white shadow-lg shadow-indigo-500/25'
          : 'bg-white/5 text-slate-300 hover:bg-white/10'
      }`}
    >
      {label}
      {typeof count === 'number' && count > 0 && (
        <span
          className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold ${
            active ? 'bg-white/30 text-white' : 'bg-rose-500 text-white'
          }`}
        >
          {count > 9 ? '+9' : count}
        </span>
      )}
    </button>
  )
}

export function FriendsPanel({ onOpenProfile }: { onOpenProfile: OpenProfileFn }) {
  const [data, setData] = useState<SocialData | null>(null)
  const [tab, setTab] = useState<'enviar' | 'convites' | 'amigos'>('enviar')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    fetch('/api/social')
      .then((r) => r.json())
      .then((d) => d?.me && setData(d))
      .catch(() => {})

  useEffect(() => {
    load()
    // Atualiza em tempo real: convites e amigos aparecem sem recarregar a página.
    const id = setInterval(load, 2500)
    return () => clearInterval(id)
  }, [])

  const copyCode = () => {
    if (!data) return
    navigator.clipboard?.writeText(data.me.friendCode).then(() => toast.success('Código copiado!')).catch(() => {})
  }

  const sendRequest = async () => {
    const c = code.trim().toUpperCase()
    if (!c) return toast.error('Digite o código do amigo')
    setBusy(true)
    const res = await post({ action: 'send-request', toCode: c } as any)
    setBusy(false)
    if (res?.ok) {
      toast.success(res.message || 'Convite enviado!')
      setCode('')
    } else {
      toast.error(res?.message || 'Não foi possível enviar')
    }
  }

  const accept = async (fromId: string) => {
    const res = await post({ action: 'accept-request', fromUserId: fromId } as any)
    if (res?.ok) {
      toast.success('Agora vocês são amigos!')
      load()
    } else {
      toast.error(res?.message || 'Não foi possível aceitar')
    }
  }

  const decline = async (fromId: string) => {
    await post({ action: 'decline-request', fromUserId: fromId } as any)
    load()
  }

  const removeFriend = async (userId: string, name: string) => {
    if (!confirm('Excluir ' + name + ' da sua lista de amigos?')) return
    const res = await post({ action: 'remove-friend', userId } as any)
    if (res?.ok) {
      toast('Amizade encerrada')
      load()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Cartão do código de amigo */}
      {data && (
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-500 to-fuchsia-500 p-4">
          <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full bg-white/10" />
          <div className="absolute -bottom-8 -left-4 h-28 w-28 rounded-full bg-white/10" />
          <div className="relative">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Seu código de amigo</p>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={copyCode}
                className="font-mono text-2xl font-extrabold tracking-[0.22em] text-white"
                title="Copiar código"
              >
                {data.me.friendCode}
              </button>
              <button
                onClick={copyCode}
                className="flex items-center gap-1.5 rounded-lg bg-white/20 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-white/30"
              >
                📋 Copiar
              </button>
            </div>
            <p className="mt-2 text-[11px] text-white/70">
              Compartilhe para que um amigo possa te adicionar.
            </p>
          </div>
        </div>
      )}

      {!data ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-white/5 bg-white/5 px-4 py-10 text-center">
          <span className="text-3xl">⏳</span>
          <p className="text-xs text-slate-400">Carregando seus amigos...</p>
        </div>
      ) : (
        <>
          {/* Contadores */}
          <div className="grid grid-cols-3 gap-2">
            <StatCard icon="🤝" value={data.me.friendsCount} label="Amigos" />
            <StatCard icon="👥" value={data.me.followersCount} label="Seguidores" />
            <StatCard icon="👀" value={data.me.followingCount} label="Seguindo" />
          </div>

          {/* Abas */}
          <div className="flex gap-2">
            <Aba active={tab === 'enviar'} onClick={() => setTab('enviar')} label="Enviar" />
            <Aba active={tab === 'convites'} onClick={() => setTab('convites')} label="Convites" count={data.requests.length} />
            <Aba active={tab === 'amigos'} onClick={() => setTab('amigos')} label="Amigos" count={data.friends.length} />
          </div>
        </>
      )}

      <div className="space-y-2">
        {tab === 'enviar' && (
          <div className="space-y-2">
            <div className="rounded-2xl border border-white/5 bg-white/5 p-3">
              <p className="text-xs text-slate-300">
                Digite o <span className="font-semibold text-indigo-300">código de 6 letras/números</span> de quem quer
                adicionar:
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={8}
                  onKeyDown={(e) => e.key === 'Enter' && void sendRequest()}
                  placeholder="EX: A7K3PQ"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-lg uppercase tracking-widest text-white outline-none placeholder:text-slate-500 focus:border-indigo-400/60"
                />
                <button
                  onClick={() => void sendRequest()}
                  disabled={busy}
                  className="shrink-0 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? '...' : 'Enviar'}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'convites' &&
          (data && data.requests.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center">
              <span className="text-3xl">📭</span>
              <p className="text-sm font-semibold text-slate-300">Nenhum convite pendente</p>
              <p className="text-xs text-slate-500">Quando alguém te adicionar, aparece aqui.</p>
            </div>
          ) : (
            data?.requests.map((r) => (
              <div
                key={r.requestId}
                className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/5 px-3 py-2.5 transition hover:bg-white/10"
              >
                <div className="rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 p-0.5">
                  <div className="rounded-full bg-slate-900 p-0.5">
                    <Avatar name={r.displayName} photo={r.photo} size={36} />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{r.displayName}</p>
                  <p className="text-[11px] text-slate-500">quer ser seu amigo</p>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => void accept(r.fromId)}
                    title="Aceitar"
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-base font-bold text-emerald-300 ring-1 ring-emerald-400/40 transition hover:bg-emerald-500/40 hover:text-white"
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => void decline(r.fromId)}
                    title="Recusar"
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/20 text-base font-bold text-rose-300 ring-1 ring-rose-400/40 transition hover:bg-rose-500/40 hover:text-white"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))
          ))}

        {tab === 'amigos' &&
          (data && data.friends.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center">
              <span className="text-3xl">🌟</span>
              <p className="text-sm font-semibold text-slate-300">Você ainda não tem amigos</p>
              <p className="text-xs text-slate-500">Envie seu código para começar.</p>
            </div>
          ) : (
            data?.friends.map((f) => {
              const following = data?.following.some((x) => x.id === f.id) ?? false
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-2 rounded-2xl border border-white/5 bg-white/5 px-3 py-2.5 transition hover:bg-white/10"
                >
                  <button
                    onClick={() => onOpenProfile({ userId: f.id, name: f.name, photo: f.photo, bio: f.bio, cover: f.cover })}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    title="Ver perfil"
                  >
                    <div className="relative shrink-0">
                      <div className="rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 p-0.5">
                        <div className="rounded-full bg-slate-900 p-0.5">
                          <Avatar name={f.name} photo={f.photo} size={38} />
                        </div>
                      </div>
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-slate-900 ${
                          f.online ? 'bg-emerald-400' : 'bg-slate-600'
                        }`}
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{f.name}</p>
                      <p className={`text-[11px] ${f.online ? 'text-emerald-300' : 'text-slate-500'}`}>
                        {f.online ? '● Online' : 'Offline'}
                      </p>
                    </div>
                  </button>
                  <button
                    onClick={() => removeFriend(f.id, f.name)}
                    className="shrink-0 rounded-lg bg-rose-500/15 px-2.5 py-1.5 text-xs font-semibold text-rose-300 ring-1 ring-rose-400/20 transition hover:bg-rose-500/25 hover:text-white"
                  >
                    Remover
                  </button>
                  <FriendMoreMenu
                    userId={f.id}
                    isFollowing={following}
                    canRemove
                    onOpenProfile={() => onOpenProfile({ userId: f.id, name: f.name, photo: f.photo, bio: f.bio, cover: f.cover })}
                    onChanged={load}
                  />
                </div>
              )
            })
          ))}
      </div>
    </div>
  )
}
