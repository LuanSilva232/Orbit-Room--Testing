'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

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
  <>
    {photo ? (
      <img src={photo} alt="" width={size} height={size} className="h-10 w-10 shrink-0 rounded-full object-cover" />
    ) : (
      <div
        style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
        className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/40 to-fuchsia-500/40 font-bold text-white"
      >
        {(name || '?').charAt(0).toUpperCase()}
      </div>
    )}
  </>
)

function Aba({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition ${
        active ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30' : 'bg-white/5 text-slate-300 hover:bg-white/10'
      }`}
    >
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className={`ml-1 rounded-full px-1.5 text-[10px] ${active ? 'bg-white/25' : 'bg-indigo-500/30'}`}>{count}</span>
      )}
    </button>
  )
}

export function FriendsPanel() {
  const [data, setData] = useState<SocialData | null>(null)
  const [tab, setTab] = useState<'enviar' | 'convites' | 'amigos'>('enviar')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => fetch('/api/social').then((r) => r.json()).then((d) => d?.me && setData(d)).catch(() => {})

  useEffect(() => {
    load()
  }, [])

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
    if (res?.ok) { toast.success('Agora vocês são amigos!'); load() }
    else toast.error(res?.message || 'Não foi possível aceitar')
  }

  const decline = async (fromId: string) => {
    await post({ action: 'decline-request', fromUserId: fromId } as any)
    load()
  }

  const removeFriend = async (userId: string, name: string) => {
    if (!confirm('Excluir ' + name + ' da sua lista de amigos?')) return
    const res = await post({ action: 'remove-friend', userId } as any)
    if (res?.ok) { toast('Amizade encerrada'); load() }
  }

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Amigos</p>

      {!data ? (
        <p className="mt-3 text-xs text-slate-400">Carregando...</p>
      ) : (
        <>
          {/* Meu código */}
          <div className="mt-3 rounded-xl border border-indigo-400/20 bg-indigo-500/10 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-indigo-200/70">Seu código de amigo</p>
            <button
              onClick={() => { navigator.clipboard?.writeText(data.me.friendCode); toast('Código copiado!') }}
              className="mt-1 font-mono text-2xl font-bold tracking-[0.2em] text-indigo-100"
            >
              {data.me.friendCode}
            </button>
            <p className="mt-1 text-[11px] text-slate-400">É só compartilhar com um amigo para ele te adicionar.</p>
          </div>

          {/* Contadores */}
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-white/5 px-2 py-2"><div className="text-lg font-bold">{data.me.friendsCount}</div><div className="text-[10px] text-slate-400">Amigos</div></div>
            <div className="rounded-xl bg-white/5 px-2 py-2"><div className="text-lg font-bold">{data.me.followersCount}</div><div className="text-[10px] text-slate-400">Seguidores</div></div>
            <div className="rounded-xl bg-white/5 px-2 py-2"><div className="text-lg font-bold">{data.me.followingCount}</div><div className="text-[10px] text-slate-400">Seguindo</div></div>
          </div>
        </>
      )}

      {/* Abas */}
      <div className="mt-4 flex gap-2">
        <Aba active={tab === 'enviar'} onClick={() => setTab('enviar')} label="Enviar" />
        <Aba active={tab === 'convites'} onClick={() => setTab('convites')} label="Convites" count={data?.requests.length} />
        <Aba active={tab === 'amigos'} onClick={() => setTab('amigos')} label="Amigos" count={data?.friends.length} />
      </div>

      <div className="mt-4 space-y-2">
        {tab === 'enviar' && (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">Digite o código de 6 letras/números de quem quer adicionar:</p>
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
              className="w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:bg-indigo-400 disabled:opacity-50"
            >
              {busy ? 'Enviando...' : 'Enviar convite'}
            </button>
          </div>
        )}

        {tab === 'convites' && (
          data && (data.requests.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">Nenhum convite pendente.</p>
          ) : (
            data.requests.map((r) => (
              <div key={r.requestId} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                <Avatar name={r.displayName} photo={r.photo} size={38} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.displayName}</p>
                  <p className="text-[11px] text-slate-500">quer ser seu amigo</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void accept(r.fromId)}
                    title="Aceitar"
                    className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/20 text-lg font-bold text-emerald-300 ring-1 ring-emerald-400/40 transition hover:bg-emerald-500/40"
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => void decline(r.fromId)}
                    title="Recusar"
                    className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-500/20 text-lg font-bold text-rose-300 ring-1 ring-rose-400/40 transition hover:bg-rose-500/40"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))
          ))
        )}

        {tab === 'amigos' && (
          data && (data.friends.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">Você ainda não tem amigos aqui.</p>
          ) : (
            data.friends.map((f) => (
              <div key={f.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                <div className="relative">
                  <Avatar name={f.name} photo={f.photo} size={40} />
                  <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-slate-900 ${f.online ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{f.name}</p>
                  <p className="text-[11px] text-slate-400">{f.online ? 'Online' : 'Offline'}</p>
                </div>
                <button
                  onClick={() => removeFriend(f.id, f.name)}
                  className="rounded-lg bg-rose-500/15 px-2.5 py-1.5 text-xs font-semibold text-rose-300 ring-1 ring-rose-400/20 hover:bg-rose-500/25"
                >
                  Remover
                </button>
              </div>
            ))
          ))
        )}
      </div>
    </div>
  )
}