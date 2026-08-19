'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

const ERROR_MESSAGES: Record<string, string> = {
  GOOGLE_NOT_CONFIGURED:
    'O login com Google ainda não foi configurado neste app. Peça ao dono para adicionar as chaves do Google.',
  INVALID_STATE: 'Sua solicitação de login expirou. Clique novamente para entrar.',
  INVALID_CALLBACK: 'A resposta do Google veio incompleta. Tente novamente.',
  TOKEN_EXCHANGE_FAILED: 'O Google não confirmou seu login. Tente novamente.',
  INVALID_TOKEN: 'Não foi possível confirmar sua identidade. Tente novamente.',
  UNVERIFIED_EMAIL: 'Sua conta do Google precisa ter e-mail verificado.',
}

function GoogleG() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get('error')
    if (e) setError(e)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.user) router.replace('/')
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [router])

  const startLogin = () => {
    window.location.assign('/api/auth/login?next=/')
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0b0f1f] px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <img
            src="/logo.png"
            alt="Orbit Room"
            className="h-24 w-24 object-contain drop-shadow-2xl"
          />
          <h1 className="font-brand mt-3 bg-gradient-to-r from-indigo-400 via-fuchsia-400 to-indigo-400 bg-clip-text text-3xl font-bold uppercase tracking-[0.1em] text-transparent">
            Orbit Room
          </h1>
          <p className="mt-2 text-sm text-slate-400">Entre para salvar seu perfil e suas salas.</p>
        </div>

        <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl backdrop-blur">
          <h2 className="text-lg font-semibold text-slate-100">Entrar</h2>
          <p className="mt-1 text-sm text-slate-400">
            Use sua conta do Google. Seu nome, bio, foto e salas ficam salvos na sua conta.
          </p>

          {error && (
            <div className="mt-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {ERROR_MESSAGES[error] || 'Não foi possível entrar. Tente novamente.'}
            </div>
          )}

          <button
            type="button"
            onClick={startLogin}
            disabled={checking}
            className="mt-5 flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow transition hover:bg-slate-100 disabled:opacity-60"
          >
            <GoogleG />
            {checking ? 'Verificando...' : 'Entrar com o Google'}
          </button>

          <div className="mt-4 text-center">
            <Link
              href="/"
              className="text-xs text-indigo-300 underline-offset-2 transition hover:underline"
            >
              Voltar ao Orbit Room
            </Link>
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-600">
          Seus dados são guardados de forma segura no servidor.
        </p>
      </div>
    </main>
  )
}
