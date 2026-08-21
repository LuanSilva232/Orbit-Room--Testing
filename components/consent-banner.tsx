'use client'

import { useEffect, useState } from 'react'

const CONSENT_KEY = 'orbit_consent' // 'ok' | 'denied'
const AUTHED_KEY = 'orbit_authed_device' // '1' = este aparelho já logou com Google

export function deviceAuthed(): boolean {
  try {
    return localStorage.getItem(AUTHED_KEY) === '1'
  } catch {
    return false
  }
}

export function setDeviceAuthed() {
  try {
    localStorage.setItem(AUTHED_KEY, '1')
  } catch {}
}

export function deviceDeniedCookies(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'denied'
  } catch {
    return false
  }
}

export function ConsentBanner() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let answered = false
    try {
      answered = !!localStorage.getItem(CONSENT_KEY)
    } catch {}
    if (!answered) setOpen(true)
  }, [])

  const decide = (v: 'ok' | 'denied') => {
    try {
      localStorage.setItem(CONSENT_KEY, v)
    } catch {}
    setOpen(false)
  }

  if (!open) return null
  return (
    <div className="fixed inset-x-3 bottom-3 z-50 flex justify-center lg:justify-end lg:pr-4">
      <div className="max-w-md rounded-2xl border border-white/10 bg-slate-900/90 p-4 shadow-2xl backdrop-blur">
        <p className="text-sm font-semibold text-slate-100">🍪 Guardar dados neste navegador?</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Usamos cookies para lembrar da sua conta Google e perfil. Assim você não precisa voltar a entrar toda hora.
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={() => decide('denied')}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/20"
          >
            Não, obrigado
          </button>
          <button
            onClick={() => decide('ok')}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:bg-indigo-400"
          >
            Permitir
          </button>
        </div>
      </div>
    </div>
  )
}