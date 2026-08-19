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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/** Modal de perfil de outro usuário (ver perfil). */
type Profile = { name: string; photo?: string; bio?: string }

export function ProfileViewModal({
  profile,
  onClose,
}: {
  profile: Profile
  onClose: () => void
}) {
  const profileState = profile
  return (
    <Modal open onClose={onClose}>
      <div className="flex flex-col items-center text-center">
        <Avatar name={profileState.name} photo={profileState.photo} size={96} />
        <h3 className="mt-4 text-lg font-bold">{profileState.name}</h3>
        {profileState.bio && <p className="mt-1 text-sm text-slate-400">{profileState.bio}</p>}
      </div>
    </Modal>
  )
}

/** Modal de edição do perfil (foto + bio). O nome é escolhido ao abrir a página. */
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
  const [busy, setBusy] = useState(false)

  const fileRef = useRef<HTMLInputElement | null>(null)

  const handleFile = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Escolha uma imagem')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
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
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  const save = async () => {
    setBusy(true)
    onSave({ name: profile.name, photo, bio: bio.trim() })
    setBusy(false)
    toast.success('Perfil atualizado')
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()}>
      <h2 className="text-lg font-bold">Editar perfil</h2>
      <p className="mt-1 text-xs text-slate-400">
        Seu nome ({profile.name}) é escolhido ao abrir a página. Foto e bio aparecem para todos.
      </p>

      <label className="mt-4 block text-xs font-medium text-slate-300">Foto</label>
      <div className="mt-2 flex items-center gap-3">
        {photo ? (
          <Avatar name={profile.name} photo={photo} size={56} />
        ) : (
          <Avatar name={profile.name} size={56} />
        )}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15"
        >
          Enviar foto
        </button>
        {photo && (
          <button
            onClick={() => setPhoto('')}
            className="rounded-lg bg-white/10 px-2 py-1.5 text-xs text-red-300 hover:bg-white/15"
          >
            Remover
          </button>
        )}
      </div>

      <label className="mt-4 block text-xs font-medium text-slate-300">Bio</label>
      <textarea
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        placeholder="Conte um pouco sobre você (opcional)"
        rows={3}
        className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-indigo-400/50"
      />

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-lg bg-white/10 px-4 py-2 text-sm disabled:opacity-40"
        >
          Cancelar
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Salvar
        </button>
      </div>
    </Modal>
  )
}