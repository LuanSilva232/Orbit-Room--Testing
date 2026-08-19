'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Modal, Avatar } from './modals'

type Profile = { name: string; photo?: string; bio?: string; cover?: string; userId?: string }

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

/** Modal de perfil de outro usuário, com ⋮ contextual (adicionar/seguir ou deixar de ser amigo/deixar de seguir). */
export function ProfileViewModal({
  profile,
  currentUserId,
  onClose,
}: {
  profile: Profile
  currentUserId?: string
  onClose: () => void
}) {
  const userId = profile.userId
  const [relation, setRelation] = useState<Relation>({ isFriend: false, isFollowing: false, isSelf: false })
  const [counts, setCounts] = useState<Counts | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => {
    if (!userId || userId === currentUserId) return
    fetch('/api/social/user?userId=' + encodeURIComponent(userId))
      .then((r) => r.json())
      .then((d) => {
        if (d?.relation) setRelation(d.relation)
        if (d && typeof d.friendsCount === 'number') {
          setCounts({ friendsCount: d.friendsCount, followersCount: d.followersCount, followingCount: d.followingCount })
        }
      })
      .catch(() => {})
  }

  useEffect(() => {
    setMenuOpen(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, currentUserId])

  const isMine = Boolean(userId && userId === currentUserId)
  const canAct = Boolean(userId && currentUserId && userId !== currentUserId)

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

  return (
    <Modal open onClose={onClose}>
      {/* Faixa de destaque no topo (capa ou gradiente) */}
      {profile.cover ? (
        <div className="absolute inset-x-0 top-0 h-28 rounded-t-2xl bg-cover bg-center" style={{ backgroundImage: `url(${profile.cover})` }} />
      ) : (
        <div className="absolute inset-x-0 top-0 h-28 rounded-t-2xl bg-gradient-to-br from-indigo-500/45 via-purple-500/25 to-fuchsia-500/35" />
      )}

      {/* ⋮ no canto superior direito */}
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
            <div className="share-panel absolute right-0 top-11 flex w-56 flex-col overflow-hidden rounded-xl p-1 shadow-2xl">
              {!relation.isFriend ? (
                <button
                  disabled={busy}
                  onClick={() => void run('send-request', { toUserId: userId }, 'Convite enviado!')}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-emerald-300 hover:bg-white/5 disabled:opacity-50"
                >
                  🤝 Adicionar amigo
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => void run('remove-friend', { userId }, 'Amizade encerrada.')}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-rose-300 hover:bg-white/5 disabled:opacity-50"
                >
                  🚫 Deixar de ser amigo
                </button>
              )}
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
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {relation.isFriend ? 'Amigo(a)' : isMine ? 'Este é o seu perfil' : 'Perfil público'}
        </div>

        {counts && (
          <div className="mt-4 flex w-full gap-2">
            {countBox('Amigos', counts.friendsCount)}
            {countBox('Seguidores', counts.followersCount)}
            {countBox('Seguindo', counts.followingCount)}
          </div>
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
    </Modal>
  )
}
