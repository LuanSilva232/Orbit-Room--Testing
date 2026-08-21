'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Modal, Avatar } from './modals'

type Profile = { name: string; photo?: string; bio?: string; cover?: string; userId?: string }

type ListItem = { id: string; name: string; photo?: string | null; online?: boolean; channelId?: string | null }
type Lists = { friends: ListItem[]; followers: ListItem[]; following: ListItem[] }

const socialPost = (body: Record<string, unknown>) =>
  fetch('/api/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ ok: false, message: 'Falha de rede' }))

type Relation = { isFriend: boolean; isFollowing: boolean; isSelf: boolean }
type Counts = { friendsCount: number; followersCount: number; followingCount: number }
type TabId = 'friends' | 'followers' | 'following'

/** Modal de perfil de outro usuário, com botão de amizade e listas sociais (só para amigos). */
export function ProfileViewModal({
  profile,
  currentUserId,
  onClose,
  onNavigate,
}: {
  profile: Profile
  currentUserId?: string
  onClose: () => void
  onNavigate?: (u: { userId: string; name: string; photo?: string | null }) => void
}) {
  const userId = profile.userId
  const [relation, setRelation] = useState<Relation>({ isFriend: false, isFollowing: false, isSelf: false })
  const [requestStatus, setRequestStatus] = useState<'sent' | 'received' | null>(null)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [lists, setLists] = useState<Lists>({ friends: [], followers: [], following: [] })
  const [online, setOnline] = useState<boolean | null>(null)
  const [tab, setTab] = useState<TabId | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => {
    if (!userId) return
    fetch('/api/social/user?userId=' + encodeURIComponent(userId))
      .then((r) => r.json())
      .then((d) => {
        if (d?.relation) setRelation(d.relation)
        if (typeof d?.requestStatus === 'string') setRequestStatus(d.requestStatus)
        else setRequestStatus(null)
        if (d && typeof d.friendsCount === 'number') {
          setCounts({ friendsCount: d.friendsCount, followersCount: d.followersCount, followingCount: d.followingCount })
        }
        setLists({
          friends: d?.friends || [],
          followers: d?.followers || [],
          following: d?.following || [],
        })
        setOnline(typeof d?.user?.online === 'boolean' ? d.user.online : null)
      })
      .catch(() => {})
  }

  useEffect(() => {
    setMenuOpen(false)
    setConfirmRemove(false)
    setTab(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, currentUserId])

  const isMine = Boolean(userId && userId === currentUserId)
  const canAct = Boolean(userId && currentUserId && userId !== currentUserId)
  const canSeeLists = relation.isSelf || relation.isFriend

  const run = async (action: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(true)
    const res = await socialPost({ action, ...body })
    setBusy(false)
    toast(res?.ok ? okMsg : res?.message || 'Não foi possível')
    setMenuOpen(false)
    load()
  }

  const countBox = (label: string, value: number) => (
    <div className="flex-1 rounded-xl bg-white/5 px-2 py-2 text-center ring-1 ring-white/10">
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  )

  const listTab = (id: TabId, label: string, count: number) => (
    <button
      onClick={() => setTab((v) => (v === id ? null : id))}
      className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${
        tab === id ? 'bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'
      }`}
    >
      {label} ({count})
    </button>
  )

  const renderList = (items: ListItem[]) =>
    items.length === 0 ? (
      <p className="py-4 text-center text-xs text-slate-500">Ninguém aqui ainda.</p>
    ) : (
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {items.map((it) => (
          <li key={it.id}>
            <button
              onClick={() => onNavigate?.({ userId: it.id, name: it.name, photo: it.photo })}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 transition hover:bg-white/5"
              title="Abrir perfil"
            >
              <div className="relative shrink-0">
                <Avatar name={it.name} photo={it.photo ?? undefined} size={28} />
                {it.online && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-slate-900 bg-emerald-400" />
                )}
              </div>
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              <span className="text-slate-500">→</span>
            </button>
          </li>
        ))}
      </ul>
    )

  return (
    <Modal open onClose={onClose}>
      {/* Faixa de destaque no topo (capa ou gradiente) */}
      {profile.cover ? (
        <div className="absolute inset-x-0 top-0 h-28 rounded-t-2xl bg-cover bg-center" style={{ backgroundImage: `url(${profile.cover})` }} />
      ) : (
        <div className="absolute inset-x-0 top-0 h-28 rounded-t-2xl bg-gradient-to-br from-indigo-500/45 via-purple-500/25 to-fuchsia-500/35" />
      )}

      {/* ⋮ no canto superior direito (seguir/parar de seguir) */}
      {canAct && (
        <div className="absolute right-4 top-4 z-10">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/60 text-lg text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-slate-900/80"
            aria-label="Opções"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="share-panel absolute right-0 top-11 flex w-52 flex-col overflow-hidden rounded-xl p-1 shadow-2xl">
              {relation.isFollowing ? (
                <button
                  disabled={busy}
                  onClick={() => void run('unfollow', { userId }, 'Você deixou de seguir.')}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50"
                >
                  ⛔ Deixar de seguir
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => void run('follow', { userId }, 'Você agora segue esta pessoa.')}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-indigo-200 hover:bg-white/5 disabled:opacity-50"
                >
                  ➕ Seguir
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="relative mt-10 flex flex-col items-center text-center">
        <div className="rounded-full ring-4 ring-slate-900">
          <Avatar name={profile.name} photo={profile.photo} size={112} className="border-2 border-white/20" />
        </div>

        <h3 className="mt-4 text-xl font-extrabold tracking-tight">{profile.name}</h3>

        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-slate-500'}`}
            title={online ? 'Online' : 'Offline'}
          />
          {relation.isFriend ? 'Amigo(a)' : isMine ? 'Este é o seu perfil' : 'Perfil público'}
          {online && <span className="text-emerald-300">· Online</span>}
        </div>

        {/* Botão de amizade: adicionar → pendente → remover (com confirmação) */}
        {canAct && (
          <div className="mt-3 flex w-full gap-2">
            {relation.isFriend ? (
              <button
                onClick={() => setConfirmRemove(true)}
                className="flex-1 rounded-xl bg-rose-500/20 px-3 py-2 text-sm font-semibold text-rose-300 ring-1 ring-rose-400/40 transition hover:bg-rose-500/40 hover:text-white"
              >
                🚫 Remover amizade
              </button>
            ) : requestStatus ? (
              <button
                disabled
                className="flex-1 cursor-not-allowed rounded-xl bg-slate-500/20 px-3 py-2 text-sm font-semibold text-slate-400 ring-1 ring-white/10"
              >
                ⏳ Pendente
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => void run('send-request', { toUserId: userId }, 'Convite enviado!')}
                className="flex-1 rounded-xl bg-emerald-500/20 px-3 py-2 text-sm font-semibold text-emerald-300 ring-1 ring-emerald-400/40 transition hover:bg-emerald-500/40 hover:text-white disabled:opacity-50"
              >
                🤝 Adicionar amigo
              </button>
            )}
          </div>
        )}

        {counts && (
          <div className="mt-4 flex w-full gap-2">
            {countBox('Amigos', counts.friendsCount)}
            {countBox('Seguidores', counts.followersCount)}
            {countBox('Seguindo', counts.followingCount)}
          </div>
        )}

        {/* Listas sociais — visíveis apenas para o próprio usuário ou amigos */}
        {canSeeLists ? (
          <div className="mt-4 w-full">
            <div className="flex gap-1.5 rounded-xl bg-white/5 p-1">
              {listTab('friends', 'Amigos', lists.friends.length)}
              {listTab('followers', 'Seguidores', lists.followers.length)}
              {listTab('following', 'Seguindo', lists.following.length)}
            </div>
            <div className="mt-1.5 rounded-xl bg-white/5 p-1.5">
              {tab === 'friends' && renderList(lists.friends)}
              {tab === 'followers' && renderList(lists.followers)}
              {tab === 'following' && renderList(lists.following)}
              {!tab && <p className="py-3 text-center text-xs text-slate-500">Toque em uma aba acima para ver as pessoas.</p>}
            </div>
          </div>
        ) : (
          <p className="mt-4 w-full rounded-2xl bg-white/5 px-4 py-3 text-xs italic text-slate-500 ring-1 ring-white/10">
            🔒 As listas de amigos, seguidores e seguindo ficam visíveis apenas para amigos.
          </p>
        )}

        {profile.bio ? (
          <p className="mt-4 w-full whitespace-pre-wrap rounded-2xl bg-white/5 px-4 py-3 text-sm leading-relaxed text-slate-300 ring-1 ring-white/10">
            {profile.bio}
          </p>
        ) : (
          <p className="mt-4 w-full rounded-2xl bg-white/5 px-4 py-3 text-xs italic text-slate-500 ring-1 ring-white/10">
            Esta pessoa ainda não escreveu uma bio.
          </p>
        )}

        <button
          onClick={onClose}
          className="mt-5 w-full rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:bg-indigo-400"
        >
          Fechar
        </button>
      </div>

      {/* Confirmação antes de remover a amizade */}
      {confirmRemove && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4" onClick={() => setConfirmRemove(false)}>
          <div
            className="w-full max-w-xs rounded-2xl border border-white/10 bg-slate-900 p-5 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-lg font-bold">Remover amizade</p>
            <p className="mt-2 text-sm text-slate-400">
              Tem certeza que deseja remover <span className="font-semibold text-white">{profile.name}</span> da sua lista de
              amigos?
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirmRemove(false)}
                className="flex-1 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/20"
              >
                Cancelar
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setConfirmRemove(false)
                  void run('remove-friend', { userId }, 'Amizade encerrada.')
                }}
                className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:opacity-50"
              >
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
