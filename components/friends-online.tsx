'use client'

import { useEffect, useState } from 'react'
import { FriendMoreMenu } from './friend-actions'
import type { OpenProfileFn } from './friends-panel'

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

const Avatar = ({ name, photo, size = 36 }: { name?: string; photo?: string | null; size?: number }) => (
  <>
    {photo ? (
      <img src={photo} alt="" width={size} height={size} className="h-9 w-9 shrink-0 rounded-full object-cover" />
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

// Mostra SOMENTE os amigos (online e offline). Anônimos e visitantes não aparecem.
export function FriendsOnline({ onOpenProfile }: { onOpenProfile: OpenProfileFn }) {
  const [friends, setFriends] = useState<Friend[]>([])
  const [following, setFollowing] = useState<string[]>([])
  const [logged, setLogged] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = () =>
    fetch('/api/social')
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((d) => {
        if (d?.me) {
          setLogged(true)
          setFriends((d.friends || []) as Friend[])
          setFollowing(((d.following || []) as { id: string }[]).map((x) => x.id))
        } else {
          setLogged(false)
        }
      })
      .catch(() => setLogged(false))
      .finally(() => setLoaded(true))

  useEffect(() => {
    load()
    // Atualiza em tempo real: quem fica/sai online aparece sem recarregar.
    const id = setInterval(load, 2500)
    return () => clearInterval(id)
  }, [])

  if (!loaded) return <p className="text-xs text-slate-500">Carregando...</p>

  if (!logged) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center">
        <div className="text-3xl">🤝</div>
        <p className="text-sm font-semibold">Amigos online</p>
        <p className="max-w-xs text-xs text-slate-400">
          Entre com o Google para ver quem dos seus amigos está online e interagir só entre amigos.
        </p>
        <a
          href="/login"
          className="mt-1 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110"
        >
          <span className="text-lg leading-none">🌐</span> Entrar com Google
        </a>
      </div>
    )
  }

  const online = friends.filter((f) => f.online)
  const offline = friends.filter((f) => !f.online)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
            Online ({online.length})
          </span>
        </div>
        {online.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">Nenhum amigo online agora.</p>
        ) : (
          <div className="mt-1 space-y-1">
            {online.map((f) => (
              <div key={f.id} className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm hover:bg-white/5">
                <button
                  onClick={() => onOpenProfile({ userId: f.id, name: f.name, photo: f.photo, bio: f.bio, cover: f.cover })}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="Ver perfil"
                >
                  <div className="relative shrink-0">
                    <Avatar name={f.name} photo={f.photo} size={32} />
                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-slate-900 bg-emerald-400" />
                  </div>
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {f.channelId && (
                    <span translate="no" className="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {f.channelId}
                    </span>
                  )}
                </button>
                <FriendMoreMenu
                  userId={f.id}
                  isFollowing={following.includes(f.id)}
                  canRemove
                  onOpenProfile={() => onOpenProfile({ userId: f.id, name: f.name, photo: f.photo, bio: f.bio, cover: f.cover })}
                  onChanged={load}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-white/10 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Offline ({offline.length})</span>
        {offline.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">Todos os seus amigos estão online.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {offline.map((f) => (
              <li key={f.id} className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm text-slate-400 hover:bg-white/5">
                <button
                  onClick={() => onOpenProfile({ userId: f.id, name: f.name, photo: f.photo, bio: f.bio, cover: f.cover })}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="Ver perfil"
                >
                  <div className="relative shrink-0">
                    <Avatar name={f.name} photo={f.photo} size={28} />
                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-slate-900 bg-slate-500" />
                  </div>
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                </button>
                <FriendMoreMenu
                  userId={f.id}
                  isFollowing={following.includes(f.id)}
                  canRemove
                  onOpenProfile={() => onOpenProfile({ userId: f.id, name: f.name, photo: f.photo, bio: f.bio, cover: f.cover })}
                  onChanged={load}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
