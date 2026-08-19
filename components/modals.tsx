'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'

/** Ícone de perfil quadrado (foto ou iniciais com cor derivada do nome). */
export function Avatar({
  name,
  photo,
  size = 80,
  className = '',
}: {
  name?: string
  photo?: string
  size?: number
  className?: string
}) {
  if (photo) {
    return (
      <img
        src={photo}
        alt={name ?? 'Perfil'}
        width={size}
        height={size}
        className={`rounded-full object-cover ${className}`}
      />
    )
  }
  let hash = 0
  const base = name ?? '?'
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) & 0xffffff
  const hue = hash % 40
  return (
    <div
      style={{
        width: size,
        height: size,
        background: `hsl(${hue * 9} 55% 38%)`,
      }}
      className={`flex shrink-0 items-center justify-center rounded-full text-lg font-bold text-white ${className}`}
    >
      {base.charAt(0).toUpperCase()}
    </div>
  )
}

/** Container de modal com vidro escuro, brilho gradiente e cantos suaves. */
export function Modal({
  open,
  onClose,
  children,
  className = '',
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-slate-900/90 p-6 shadow-[0_30px_80px_-25px_rgba(99,102,241,0.55)] backdrop-blur-xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute -right-20 -top-24 h-52 w-52 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-20 h-52 w-52 rounded-full bg-fuchsia-500/15 blur-3xl" />
        {children}
      </div>
    </div>
  )
}

/** Tipo de perfil público compartilhado entre os modais. */
type Profile = { name: string; photo?: string; bio?: string; cover?: string }

/** Modal de perfil de outro usuário (ver perfil) — cartão vertical organizado. */
export function ProfileViewModal({
  profile,
  onClose,
}: {
  profile: Profile
  onClose: () => void
}) {
  return (
    <Modal open onClose={onClose}>
      {/* Faixa de destaque no topo (capa ou gradiente) */}
      {profile.cover ? (
        <div className="absolute inset-x-0 top-0 h-28 bg-cover bg-center" style={{ backgroundImage: `url(${profile.cover})` }} />
      ) : (
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-indigo-500/45 via-purple-500/25 to-fuchsia-500/35" />
      )}

      <div className="relative mt-10 flex flex-col items-center text-center">
        <div className="rounded-full ring-4 ring-slate-900">
          <Avatar name={profile.name} photo={profile.photo} size={112} className="border-2 border-white/20" />
        </div>

        <h3 className="mt-4 text-xl font-extrabold tracking-tight">{profile.name}</h3>

        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Perfil público
        </div>

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

/** Modal de edição do perfil — nome, foto e bio salvos na conta. */
export function ProfileEditModal({
  open,
  profile,
  onClose,
  onSave,
}: {
  open: boolean
  profile: Profile
  onClose: () => void
  onSave: (next: Profile) => void
}) {
  const [bio, setBio] = useState(profile.bio ?? '')
  const [photo, setPhoto] = useState(profile.photo)
  const [cover, setCover] = useState(profile.cover)
  const [name, setName] = useState(profile.name ?? '')
  const [busy, setBusy] = useState(false)

  const fileRef = useRef<HTMLInputElement | null>(null)
  const coverRef = useRef<HTMLInputElement | null>(null)

  const readImage = (file: File, cb: (dataUrl: string) => void) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Escolha uma imagem')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        cb(reader.result as string)
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  const handleFile = (file: File | undefined) => {
    readImage(file as File, (src) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, 256, 256)
        const cropped = canvas.toDataURL('image/jpeg', 0.85)
        setPhoto(cropped)
      }
      img.src = src
    })
  }

  const handleCoverFile = (file: File | undefined) => {
    readImage(file as File, (src) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = 800
        canvas.height = 320
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        // Preenche e recorta a imagem de fundo centralizada.
        const iw = img.width
        const ih = img.height
        const scale = Math.max(800 / iw, 320 / ih)
        const w = iw * scale
        const h = ih * scale
        ctx.drawImage(img, (800 - w) / 2, (320 - h) / 2, w, h)
        const cropped = canvas.toDataURL('image/jpeg', 0.85)
        setCover(cropped)
      }
      img.src = src
    })
  }

  const save = async () => {
    setBusy(true)
    const finalName = name.trim() || profile.name || 'Anônimo'
    onSave({ name: finalName, photo, cover, bio: bio.trim() })
    setBusy(false)
    toast.success('Perfil atualizado')
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()}>
      {/* Faixa de destaque no topo (capa ou gradiente) */}
      {cover ? (
        <div className="absolute inset-x-0 top-0 h-24 bg-cover bg-center" style={{ backgroundImage: `url(${cover})` }} />
      ) : (
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-br from-indigo-500/45 via-purple-500/25 to-fuchsia-500/35" />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <input
        ref={coverRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleCoverFile(e.target.files?.[0])}
      />

      {/* Avatar com botão de trocar foto */}
      <div className="relative mt-9 flex justify-center">
        <div className="relative">
          <Avatar name={name || profile.name} photo={photo} size={92} className="border-2 border-white/20 ring-4 ring-slate-900" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Enviar foto"
            className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full bg-indigo-500 text-base text-white shadow-lg shadow-indigo-500/40 ring-2 ring-slate-900 transition hover:bg-indigo-400"
          >
            📷
          </button>
          {photo && (
            <button
              type="button"
              onClick={() => setPhoto('')}
              title="Remover foto"
              className="absolute -bottom-1 -left-1 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-[11px] text-white ring-2 ring-slate-900 transition hover:bg-rose-400"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="relative mt-3 text-center">
        <h2 className="text-lg font-extrabold tracking-tight">Editar perfil</h2>
        <p className="mt-1 text-xs text-slate-400">Salvo na sua conta (Google) e visível para todos.</p>
      </div>

      {/* Nome */}
      <label className="relative mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Nome</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Digite seu nome"
        maxLength={40}
        className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
      />

      {/* Bio */}
      <label className="relative mt-4 block text-xs font-semibold uppercase tracking-wider text-slate-400">Bio</label>
      <textarea
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        placeholder="Conte um pouco sobre você (opcional)"
        rows={3}
        className="mt-1.5 w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
      />

      {/* Foto de fundo (capa) */}
      <label className="relative mt-4 block text-xs font-semibold uppercase tracking-wider text-slate-400">Foto de fundo</label>
      <div className="mt-1.5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => coverRef.current?.click()}
          className="flex items-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-indigo-400/50 hover:bg-white/10"
        >
          🖼️ {cover ? 'Trocar capa' : 'Adicionar capa'}
        </button>
        {cover && (
          <button
            type="button"
            onClick={() => setCover('')}
            className="flex items-center gap-1 rounded-xl bg-white/10 px-3 py-2.5 text-xs font-semibold text-slate-300 transition hover:bg-rose-500/20 hover:text-rose-200"
          >
            ✕ Remover
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">
        Qualquer imagem serve — ajustamos o enquadramento automaticamente. Para ficar ainda melhor, prefira uma
        imagem larga (deitada), como <span translate="no">1500×600 px</span>. Ela aparece no topo do seu perfil e ao
        lado das suas mensagens.
      </p>

      <div className="relative mt-6 flex gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="flex-1 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/15 disabled:opacity-40"
        >
          Cancelar
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="flex-1 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:bg-indigo-400 disabled:opacity-40"
        >
          Salvar
        </button>
      </div>
    </Modal>
  )
}
