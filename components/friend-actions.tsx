'use client'

import { useState } from 'react'
import { toast } from 'sonner'

type Props = {
  userId: string
  isFollowing: boolean
  canRemove?: boolean
  onOpenProfile: () => void
  onChanged?: () => void
}

const post = (body: { action: string; [k: string]: unknown }) =>
  fetch('/api/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ ok: false, message: 'Falha de rede' }))

/** Menu ⋮ compacto: ver perfil, seguir/parar de seguir e remover amizade. */
export function FriendMoreMenu({ userId, isFollowing, canRemove, onOpenProfile, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (action: string, okMsg: string) => {
    setBusy(true)
    const res = await post({ action, userId })
    setBusy(false)
    toast(res?.ok ? okMsg : res?.message || 'Não foi possível')
    setOpen(false)
    onChanged?.()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-base text-slate-400 transition hover:bg-white/10 hover:text-white"
        aria-label="Opções do amigo"
        title="Ver perfil e mais opções"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="share-panel absolute right-0 top-9 z-40 flex w-52 flex-col overflow-hidden rounded-xl p-1 shadow-2xl">
            <button
              onClick={() => {
                setOpen(false)
                onOpenProfile()
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-100 hover:bg-white/5"
            >
              👁️ Ver perfil
            </button>
            <button
              disabled={busy}
              onClick={() => void run(isFollowing ? 'unfollow' : 'follow', isFollowing ? 'Você deixou de seguir.' : 'Você agora segue esta pessoa.')}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-white/5 disabled:opacity-50 ${
                isFollowing ? 'text-slate-300' : 'text-indigo-200'
              }`}
            >
              {isFollowing ? '⛔ Deixar de seguir' : '➕ Seguir'}
            </button>
            {canRemove && (
              <button
                disabled={busy}
                onClick={() => {
                  if (!confirm('Excluir esta pessoa da sua lista de amigos?')) return
                  void run('remove-friend', 'Amizade encerrada.')
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-rose-300 hover:bg-white/5 disabled:opacity-50"
              >
                🚫 Remover amizade
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
