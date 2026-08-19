'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast, Toaster } from 'sonner'

import { apiClient } from '@/lib/request'
import { RtcEngine, DEFAULT_ICE } from '@/lib/rtc/rtc-engine'
import {
  channelLabel,
  DEFAULT_CHANNELS,
  type ChannelId,
  type ChatMessage,
  type MailboxMessage,
  type Member,
  type Profile,
  type Quality,
  QUALITY_OPTIONS,
  type SignalKind,
} from '@/lib/rtc/types'

import { Avatar, ProfileEditModal, ProfileViewModal } from './modals'

const OFFLINE_MS = 15 * 60 * 1000 // 15min sem atividade = offline ("fantasma")

const CLIENT_KEY = 'share_room_client_id'
const PROFILE_KEY = 'share_room_profile'

type Remote = { name: string; streams: MediaStream[] }

// Mostra quanto tempo se passou desde um instante, em linguagem curta ("há 3 min", "há 2 h").
const formatAgo = (ts: number): string => {
  const diff = Math.max(0, Date.now() - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  const days = Math.floor(hours / 24)
  return `há ${days} d`
}

type Tile = {
  id: string
  name: string
  stream: MediaStream | null
  hasVideo: boolean
  isLocal: boolean
  peerId: string | null
  muted: boolean
  isScreen?: boolean
  photo?: string
}

const QUALITY_CONSTRAINTS: Record<Quality, MediaTrackConstraints> = {
  auto: {},
  baixa: { frameRate: { ideal: 15 }, width: { ideal: 640 } },
  media: { frameRate: { ideal: 24 }, width: { ideal: 960 } },
  alta: { frameRate: { ideal: 30 }, width: { ideal: 1280 } },
}

// Interruptor (switch) reutilizável das Configurações.
function SwitchRow({
  checked,
  onChecked,
  title,
  desc,
}: {
  checked: boolean
  onChecked: (v: boolean) => void
  title: string
  desc?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChecked(!checked)}
      className="flex w-full items-center justify-between gap-3 text-left"
    >
      <span>
        <span className="block text-sm font-bold">{title}</span>
        {desc && <span className="block text-xs text-slate-400">{desc}</span>}
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          checked ? 'bg-emerald-500' : 'bg-slate-600'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? 'left-4' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}

export function ShareRoom() {
  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<ChannelId>('geral')
  const [inCall, setInCall] = useState(false)
  const [onlineMembers, setOnlineMembers] = useState<Member[]>([])
  const [offlineMembers, setOfflineMembers] = useState<Member[]>([])
  const [remotePeers, setRemotePeers] = useState<Record<string, Remote>>({})
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [camOn, setCamOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [screenStreaming, setScreenStreaming] = useState(false)
  const [quality, setQuality] = useState<Quality>('auto')

  const [profile, setProfile] = useState<Profile>({ name: '' })
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const [viewProfile, setViewProfile] = useState<Profile | null>(null)
  const [profileMenuMsg, setProfileMenuMsg] = useState<string | null>(null)

  const [mutedPeers, setMutedPeers] = useState<Record<string, boolean>>({})
  const [recording, setRecording] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adminOn, setAdminOn] = useState(false)

  // Categoria ativa no mobile (barra inferior). Desktop não usa.
  const [mobileTab, setMobileTab] = useState<'salas' | 'chamadas' | 'chat' | 'config'>('salas')
  // Sub-tela do painel de Configurações no mobile (cada categoria abre a sua).
  const [configPane, setConfigPane] = useState<
    | 'menu'
    | 'perfil'
    | 'avancado'
    | 'audio'
    | 'aparencia'
    | 'notificacoes'
    | 'silencioso'
    | 'idioma'
    | 'limpeza'
    | 'sobre'
  >('menu')

  // ----- Preferências globais (persistidas no navegador) -----
  type Settings = {
    volume: number
    noiseSuppression: boolean
    echoCancellation: boolean
    defaultQuality: Quality
    theme: 'dark' | 'light'
    notifications: boolean
    silentMode: boolean
    language: 'pt' | 'en'
  }
  const SETTINGS_KEY = 'share_room_settings'
  const DEFAULT_SETTINGS: Settings = {
    volume: 1,
    noiseSuppression: true,
    echoCancellation: true,
    defaultQuality: 'auto',
    theme: 'dark',
    notifications: false,
    silentMode: false,
    language: 'pt',
  }
  const loadSettings = (): Settings => {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
    } catch {
      /* noop */
    }
    return DEFAULT_SETTINGS
  }
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const setSetting = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((s) => {
      const next = { ...s, [k]: v }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* noop */
      }
      return next
    })
  }, [])

  // Ativa o tema claro também no fundo da página inteira (body).
  useEffect(() => {
    const el = typeof document !== 'undefined' ? document.body : null
    if (!el) return
    el.classList.toggle('theme-light', settings.theme === 'light')
    return () => el.classList.remove('theme-light')
  }, [settings.theme])

  const turnAdminOn = useCallback((pwd: string) => {
    if (pwd !== '9921174') {
      toast.error('Senha incorreta')
      return
    }
    setIsAdmin(true)
    setAdminOn(true)
    localStorage.setItem('share_room_admin', '1')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('admin-changed', { detail: { isAdmin: true } }))
    }
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('share_room_admin')
    if (stored === '1') setIsAdmin(true)
  }, [])

  const engineRef = useRef<RtcEngine | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const clientIdRef = useRef('')
  const nameRef = useRef('')
  const channelRef = useRef<ChannelId>('geral')
  const inCallRef = useRef(false)
  const remotePeersRef = useRef<Record<string, Remote>>({})
  const screenTrackIdsRef = useRef<Record<string, string[]>>({})
  const seenChatRef = useRef<Set<string>>(new Set())
  const profileRef = useRef<Profile>({ name: '' })
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recordChunksRef = useRef<Blob[]>([])

  // ----- utils -----
  const sendSignalBody = useCallback(
    (payload: { to: string; kind: SignalKind; data: unknown }) => {
      void apiClient.post('/api/rtc', {
        action: 'signal',
        from: clientIdRef.current,
        to: payload.to,
        kind: payload.kind,
        data: payload.data,
      })
    },
    []
  )

  const bind = useCallback((el: HTMLMediaElement | null, stream: MediaStream | null) => {
    if (!el || !stream) return
    if (el.srcObject !== stream) el.srcObject = stream
    // Volume global do usuário (ajustado em Configurações → Áudio e vídeo).
    if (typeof el.volume === 'number') {
      el.volume = Math.max(0, Math.min(1, volumeRef.current))
    }
  }, [])

  // Ref para o volume, para que os elementos apliquem sempre o valor atual.
  const volumeRef = useRef<number>(1)
  volumeRef.current = settings.volume

  // Avisa os demais quais trilhas de vídeo são compartilhamento de tela.
  const broadcastScreenKind = useCallback((trackIds: string[]) => {
    void apiClient.post('/api/rtc', {
      action: 'screen-kind',
      clientId: clientIdRef.current,
      trackIds,
    })
  }, [])

  // Referência ao elemento de cada tile para a função de tela cheia real.
  const tileElsRef = useRef<Record<string, HTMLDivElement | null>>({})

  const toggleTileFullscreen = useCallback((id: string) => {
    const el = tileElsRef.current[id]
    if (!el) return
    const video = el.querySelector('video') as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null
    if (document.fullscreenElement === el) {
      void document.exitFullscreen?.()
      return
    }
    // No mobile (ex.: iOS, que também vale para o Chrome do iPhone) a tela cheia
    // só funciona sobre um <video>. Prioriza esse método e cai no padrão do desktop.
    if (video && typeof video.webkitEnterFullscreen === 'function') {
      video.webkitEnterFullscreen()
      return
    }
    void el.requestFullscreen?.().catch(() => {
      toast.error('Tela cheia indisponível neste navegador')
    })
  }, [])

  // ----- local stream -----
  const replaceLocalStream = useCallback((stream: MediaStream | null) => {
    const engine = engineRef.current
    const old = localStreamRef.current
    if (old && old !== stream) {
      engine?.removeLocalStream(old)
      old.getTracks().forEach((t) => t.stop())
    }
    localStreamRef.current = stream
    if (stream) engine?.addLocalStream(stream)
  }, [])

  const applyQualityToStreams = useCallback((q: Quality) => {
    const tracks = [
      ...(localStreamRef.current?.getVideoTracks() ?? []),
      ...(screenStreamRef.current?.getVideoTracks() ?? []),
    ]
    const constraints = QUALITY_CONSTRAINTS[q]
    tracks.forEach((t) => void t.applyConstraints(constraints).catch(() => undefined))
  }, [])

  const setQualityAndApply = useCallback(
    (q: Quality) => {
      setQuality(q)
      applyQualityToStreams(q)
    },
    [applyQualityToStreams]
  )

  const reacquire = useCallback(
    async (withVideo: boolean) => {
      if (!inCallRef.current) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: true,
          },
          video: withVideo,
        })
        replaceLocalStream(stream)
        setMicOn(true)
        applyQualityToStreams(settings.defaultQuality)
      } catch {
        toast.error('Não foi possível acessar microfone/câmera')
      }
    },
    [replaceLocalStream, settings.echoCancellation, settings.noiseSuppression, settings.defaultQuality, applyQualityToStreams]
  )

  // ----- engine + polling -----
  useEffect(() => {
    let cachedProfile: Profile | null = null
    try {
      const cached = localStorage.getItem(PROFILE_KEY)
      if (cached) cachedProfile = JSON.parse(cached) as Profile
    } catch {
      cachedProfile = null
    }

    let sn = cachedProfile?.name?.trim() || ''
    if (!sn) {
      const oldName = localStorage.getItem('share_room_name')
      sn = (oldName || window.prompt('Como você quer ser chamado?')?.trim() || '').trim()
    }
    if (!sn) sn = 'Anon'

    // Reutiliza o id salvo, para não criar "fantasma" ao recarregar a página.
    let id = localStorage.getItem(CLIENT_KEY) || ''
    if (!id) {
      id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      localStorage.setItem(CLIENT_KEY, id)
    }

    // Persiste o perfil (nome/ foto / bio) no navegador.
    const saved: Profile = {
      name: sn,
      photo: cachedProfile?.photo,
      bio: cachedProfile?.bio,
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(saved))

    clientIdRef.current = id
    nameRef.current = sn
    setClientId(id)
    setName(sn)
    setProfile(saved)
    profileRef.current = saved

    const engine = new RtcEngine(
      id,
      sendSignalBody,
      {
        onTrack: (peerId: string, stream: MediaStream) => {
          const prev = remotePeersRef.current[peerId]
          // Guarda no máx. um stream com o mesmo id (evita duplicar na lista).
          const streams = (prev ? prev.streams : []).filter((s) => s.id !== stream.id)
          streams.push(stream)
          remotePeersRef.current = {
            ...remotePeersRef.current,
            [peerId]: { name: prev?.name ?? 'Usuário', streams },
          }
          setRemotePeers({ ...remotePeersRef.current })
        },
        onStreamGone: (peerId: string, stream: MediaStream) => {
          // Stream ficou vazio (câmera/tela desligada) — remove da lista
          // para o perfil não ficar duplicado.
          const prev = remotePeersRef.current[peerId]
          if (!prev) return
          const streams = prev.streams.filter((s) => s !== stream)
          remotePeersRef.current = { ...remotePeersRef.current, [peerId]: { ...prev, streams } }
          setRemotePeers({ ...remotePeersRef.current })
        },
        onPeerGone: (peerId: string) => {
          const next = { ...remotePeersRef.current }
          delete next[peerId]
          remotePeersRef.current = next
          setRemotePeers(next)
          const sc = { ...screenTrackIdsRef.current }
          delete sc[peerId]
          screenTrackIdsRef.current = sc
          setMutedPeers((prev) => {
            const n = { ...prev }
            delete n[peerId]
            return n
          })
        },
        onPeerConnected: () => undefined,
      },
      DEFAULT_ICE
    )
    engineRef.current = engine

    const handleMessage = async (msg: MailboxMessage) => {
      if (msg.type === 'signal') {
        await engine.handleSignal(msg.from, msg.kind, msg.data)
      } else if (msg.type === 'peer-joined') {
        const peerId = msg.member.clientId
        if (peerId !== clientIdRef.current && engine.hasPeer(peerId) === false) {
          engine.addPeer(peerId)
        }
        if (remotePeersRef.current[peerId]) {
          remotePeersRef.current[peerId].name = msg.member.name
          setRemotePeers({ ...remotePeersRef.current })
        }
        // Notificação (se ativada nas Configurações) quando alguém entra na sala.
        if (settings.notifications && peerId !== clientIdRef.current && document.hidden) {
          try {
            new Notification(`${msg.member.name} entrou em ${channelLabel(channelRef.current)}`, {
              body: 'Um participante entrou na chamada.',
            })
          } catch {
            /* noop */
          }
        }
      } else if (msg.type === 'peer-left') {
        engine.removePeer(msg.clientId)
      } else if (msg.type === 'peer-updated') {
        const peerId = msg.member.clientId
        if (remotePeersRef.current[peerId]) {
          remotePeersRef.current[peerId].name = msg.member.name
          setRemotePeers({ ...remotePeersRef.current })
        }
      } else if (msg.type === 'channel-state') {
        const peers = msg.members.filter((m) => m.clientId !== clientIdRef.current)
        peers.forEach((m) => engine.addPeer(m.clientId))
      } else if (msg.type === 'chat') {
        if (msg.message.channel !== channelRef.current) return
        if (seenChatRef.current.has(msg.message.id)) return
        seenChatRef.current.add(msg.message.id)
        setChat((prev) => [...prev, msg.message])
      } else if (msg.type === 'chat-deleted') {
        setChat((prev) => prev.filter((m) => m.id !== msg.messageId))
      } else if (msg.type === 'admin-mute') {
        setMutedPeers((prev) => ({ ...prev, [msg.targetId]: msg.muted }))
      } else if (msg.type === 'screen-kind') {
        screenTrackIdsRef.current = {
          ...screenTrackIdsRef.current,
          [msg.from]: msg.trackIds,
        }
        setRemotePeers({ ...remotePeersRef.current })
      }
    }

    let syncCount = 0
    let stopped = false

    const poll = async () => {
      if (stopped) return
      try {
        const res = await apiClient.get<{
          messages: MailboxMessage[]
          members: Member[]
          offlineMembers: Member[]
        }>(`/api/rtc?action=mailbox&clientId=${clientIdRef.current}`)
        if (!res.success) return
        setOnlineMembers(res.data?.members ?? [])
        setOfflineMembers(res.data?.offlineMembers ?? [])
        // Se a resposta não trouxer a lista de mensagens (ex.: banco temporariamente
        // indisponível), ignora este ciclo em vez de quebrar o loop de sincronização.
        if (Array.isArray(res.data?.messages)) {
          for (const m of res.data.messages) await handleMessage(m)
        }
        if (inCallRef.current && syncCount % 6 === 0) {
          syncCount = 0
          const sync = await apiClient.get<{ channel: ChannelId; members: Member[] }>(
            `/api/rtc?action=sync&clientId=${clientIdRef.current}`
          )
          if (sync.success && sync.data.channel === channelRef.current) {
            sync.data.members.forEach((m) => engine.addPeer(m.clientId))
          }
        }
        syncCount += 1
      } catch (error) {
        console.error('Falha ao sincronizar com o servidor:', error)
      }
    }

    const timer = window.setInterval(poll, 250)
    void poll()

    return () => {
      stopped = true
      window.clearInterval(timer)
      engine.closeAll()
    }
  }, [sendSignalBody, settings.notifications])

  // ----- join / leave channel + profile -----
  const joinChannel = useCallback(
    async (channelId: ChannelId) => {
      if (!clientIdRef.current) return
      // Só evita clicar de novo quando já estamos DENTRO desse canal.
      // (O "geral" é o padrão da página, então antes de entrar ele não pode bloquear.)
      if (inCallRef.current && channelId === channelRef.current) return
      engineRef.current?.closeAll()
      remotePeersRef.current = {}
      screenTrackIdsRef.current = {}
      setRemotePeers({})
      replaceLocalStream(null)
      setCamOn(false)
      setMicOn(false)
      setMutedPeers({})

      const res = await apiClient.post<{ channel: ChannelId; members: Member[] }>(
        '/api/rtc',
        {
          action: 'join',
          clientId: clientIdRef.current,
          name: nameRef.current,
          photo: profileRef.current.photo,
          bio: profileRef.current.bio,
          channel: channelId,
        }
      )
      if (!res.success) {
        toast.error(`Não foi possível entrar no canal: ${res.error || 'erro desconhecido'}`)
        return
      }
      channelRef.current = channelId
      inCallRef.current = true
      setChannel(channelId)
      setInCall(true)
      setMobileTab('chamadas')
      res.data.members.forEach((m) => engineRef.current?.addPeer(m.clientId))
      // Modo silencioso: aparece na sala sem ativar o microfone de imediato.
      if (settings.silentMode) {
        setMicOn(false)
      } else {
        await reacquire(false)
      }
      setChat([])
      seenChatRef.current = new Set()
      const hist = await apiClient.get<{ messages: ChatMessage[] }>(
        `/api/rtc?action=chat&channel=${channelId}`
      )
      if (hist.success) {
        hist.data.messages.forEach((m) => seenChatRef.current.add(m.id))
        setChat(hist.data.messages)
      }
    },
    [reacquire, replaceLocalStream, settings.silentMode]
  )

  const leaveChannel = useCallback(() => {
    engineRef.current?.closeAll()
    remotePeersRef.current = {}
    setRemotePeers({})
    replaceLocalStream(null)
    setCamOn(false)
    setMicOn(false)
    setScreenStreaming(false)
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    seenChatRef.current = new Set()
    setChat([])
    inCallRef.current = false
    setInCall(false)
    void apiClient.post('/api/rtc', { action: 'leave', clientId: clientIdRef.current })
  }, [replaceLocalStream])

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) {
      void reacquire(camOn)
      return
    }
    const next = !micOn
    stream.getAudioTracks().forEach((t) => (t.enabled = next))
    setMicOn(next)
  }, [micOn, camOn, reacquire])

  const toggleCam = useCallback(() => {
    const next = !camOn
    setCamOn(next)
    void reacquire(next)
  }, [camOn, reacquire])

  const toggleScreen = useCallback(async () => {
    const engine = engineRef.current
    if (screenStreamRef.current) {
      engine?.removeLocalStream(screenStreamRef.current)
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
      setScreenStreaming(false)
      broadcastScreenKind([])
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
      screenStreamRef.current = stream
      engine?.addLocalStream(stream)
      setScreenStreaming(true)
      broadcastScreenKind([stream.getVideoTracks()[0]?.id ?? ''].filter(Boolean))
      applyQualityToStreams(quality)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        engine?.removeLocalStream(stream)
        screenStreamRef.current = null
        setScreenStreaming(false)
        broadcastScreenKind([])
      })
    } catch {
      toast.error('Compartilhamento de tela cancelado')
    }
  }, [applyQualityToStreams, quality, broadcastScreenKind])

  const sendChat = useCallback(() => {
    const text = draft.trim()
    if (!text || !inCallRef.current) return
    setDraft('')
    void apiClient.post('/api/rtc', {
      action: 'chat',
      channel: channelRef.current,
      authorId: clientIdRef.current,
      author: nameRef.current,
      text,
    })
  }, [draft])

  const deleteChat = useCallback((messageId: string) => {
    void apiClient.post('/api/rtc', { action: 'chat-delete', messageId })
  }, [])

  // "Apagar para mim": remove apenas localmente (não avisa os outros).
  const deleteForMe = useCallback((messageId: string) => {
    setChat((prev) => prev.filter((m) => m.id !== messageId))
  }, [])

  // ----- voice recording -----
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recorderStreamRef.current = stream
      const recorder = new MediaRecorder(stream)
      recordChunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(recordChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const reader = new FileReader()
        reader.onload = () => {
          void apiClient.post('/api/rtc', {
            action: 'chat',
            channel: channelRef.current,
            authorId: clientIdRef.current,
            author: nameRef.current,
            text: '🎤 Mensagem de voz',
            type: 'voice',
            audioUrl: reader.result as string,
          })
        }
        reader.readAsDataURL(blob)
        stream.getTracks().forEach((t) => t.stop())
        recorderStreamRef.current = null
        setRecording(false)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
      toast.info('Gravando mensagem de voz...')
      window.setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          recorderRef.current.stop()
        }
      }, 60000)
    } catch {
      toast.error('Não foi possível acessar o microfone')
    }
  }, [])

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      if (recorder.state !== 'inactive') recorder.stop()
    }
    if (recorderStreamRef.current) {
      recorderStreamRef.current.getTracks().forEach((t) => t.stop())
      recorderStreamRef.current = null
    }
    recorderRef.current = null
    setRecording(false)
    toast.info('Gravação cancelada')
  }, [])

  // ----- carregar histórico -----
  useEffect(() => {
    if (!inCall) return
    void apiClient
      .get<{ messages: ChatMessage[] }>(`/api/rtc?action=chat&channel=${channel}`)
      .then((res) => {
        if (res.success) {
          res.data.messages.forEach((m) => seenChatRef.current.add(m.id))
          setChat(res.data.messages)
        }
      })
  }, [channel, inCall])

  // ----- profile actions -----
  const saveProfile = useCallback(async (next: Profile) => {
    profileRef.current = next
    setProfile(next)
    localStorage.setItem(PROFILE_KEY, JSON.stringify(next))
    setEditProfileOpen(false)
    if (next.name) nameRef.current = next.name
    if (!inCallRef.current) return
    const res = await apiClient.post<{ channel: ChannelId; members: Member[] }>(
      '/api/rtc',
      {
        action: 'join',
        clientId: clientIdRef.current,
        name: next.name,
        photo: next.photo,
        bio: next.bio,
        channel: channelRef.current,
      }
    )
    if (!res.success) toast.error(res.error)
  }, [])

  const resetMyName = useCallback(() => {
    const next = (window.prompt('Qual nome você quer usar?') || '').trim()
    if (!next) return
    const saved: Profile = {
      name: next,
      photo: profileRef.current.photo,
      bio: profileRef.current.bio,
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(saved))
    nameRef.current = next
    profileRef.current = saved
    setName(next)
    setProfile(saved)
    toast.success(`Nome alterado para ${next}`)
    if (inCallRef.current && channelRef.current) {
      void apiClient.post('/api/rtc', {
        action: 'join',
        clientId: clientIdRef.current,
        name: next,
        photo: saved.photo,
        bio: saved.bio,
        channel: channelRef.current,
      })
    }
  }, [])

  // ----- gerenciar usuários offline (fantasmas) -----
  const removeAllOffline = useCallback(async () => {
    if (!isAdmin) {
      const recent = offlineMembers.some(
        (m) => typeof m.lastSeen === 'number' && Date.now() - m.lastSeen < OFFLINE_MS
      )
      if (recent) {
        toast.warning('Ainda não passaram 15 minutos — aguarde para liberar os nomes')
        return
      }
    }
    const res = await apiClient.post<{ removed: Member[] }>('/api/rtc', {
      action: 'remove-offline',
    })
    if (res.success) {
      toast.success(
        res.data.removed.length > 0
          ? 'Registros offline apagados — nomes liberados'
          : 'Nenhum usuário offline para apagar'
      )
    }
  }, [isAdmin, offlineMembers])

  const removeOfflineMember = useCallback(async (memberId: string) => {
    if (!isAdmin) {
      const recent = offlineMembers.some(
        (m) => typeof m.lastSeen === 'number' && Date.now() - m.lastSeen < OFFLINE_MS
      )
      if (recent) {
        toast.warning('Ainda não passaram 15 minutos — aguarde para liberar 븙 o nome')
        return
      }
    }
    await apiClient.post('/api/rtc', { action: 'remove-member', clientId: memberId })
  }, [isAdmin, offlineMembers])

  // ----- grelha (layout dinâmico) -----
  const tiles: Tile[] = []
  if (inCall) {
    const localStream = localStreamRef.current
    if (camOn && localStream) {
      tiles.push({
        id: 'local-cam',
        name: `${name} (Você)`,
        stream: localStream,
        hasVideo: localStream.getVideoTracks().length > 0,
        isLocal: true,
        peerId: null,
        muted: false,
      })
    } else {
      tiles.push({
        id: 'local-avatar',
        name: `${name} (Você)`,
        stream: localStream,
        hasVideo: false,
        isLocal: true,
        peerId: null,
        muted: false,
      })
    }
    if (screenStreaming && screenStreamRef.current) {
      tiles.push({
        id: 'local-screen',
        name: `${name} · tela`,
        stream: screenStreamRef.current,
        hasVideo: true,
        isLocal: true,
        peerId: null,
        muted: false,
        isScreen: true,
      })
    }
    for (const [peerId, peer] of Object.entries(remotePeers)) {
      const screenIds = screenTrackIdsRef.current[peerId] ?? []
      peer.streams.forEach((stream, idx) => {
        const hasVideo = stream.getVideoTracks().length > 0
        const videoId = stream.getVideoTracks()[0]?.id ?? ''
        tiles.push({
          id: `remote-${peerId}-${idx}`,
          name: peer.name,
          stream,
          hasVideo,
          isLocal: false,
          peerId,
          muted: mutedPeers[peerId] ?? false,
          isScreen: hasVideo && screenIds.includes(videoId),
        })
      })
    }
  }

  const renderTile = (tile: Tile) => (
    <div
      key={tile.id}
      onContextMenu={tile.isLocal ? undefined : (e) => e.preventDefault()}
      ref={(el) => {
        tileElsRef.current[tile.id] = el
      }}
      className={`relative overflow-hidden rounded-xl border border-white/10 ${
        tile.isScreen
          ? 'aspect-video w-[420px] max-w-full sm:w-[520px] lg:w-[720px]'
          : tile.hasVideo
            ? 'aspect-video w-[300px] max-w-[80%] sm:w-[340px] lg:w-[400px]'
            : 'aspect-square w-24'
      } ${tile.hasVideo ? 'bg-black/60' : 'bg-slate-900/40'}`}
    >
      {tile.hasVideo ? (
        <video
          autoPlay
          playsInline
          muted={tile.isLocal || tile.muted}
          className="h-full w-full object-cover"
          ref={(el) => bind(el, tile.stream)}
        />
      ) : (
        <>
          {/* Áudio oculto para poder mutar participantes só-voz. */}
          {!tile.isLocal && (
            <audio
              autoPlay
              playsInline
              muted={tile.muted}
              className="hidden"
              ref={(el) => bind(el, tile.stream)}
            />
          )}
          <div className="flex h-full w-full items-center justify-center p-4">
            <div className="flex aspect-square w-16 flex-col items-center justify-center gap-1 rounded-xl bg-slate-900/80 p-1.5 ring-1 ring-white/10">
              <Avatar name={tile.name} photo={tile.photo} size={30} />
              <span className="max-w-full truncate text-[9px] text-slate-300">
                {tile.name}
              </span>
            </div>
          </div>
          {!tile.isLocal && !tile.muted && (
            <span className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> ao vivo
            </span>
          )}
        </>
      )}

      {/* rótulo inferior (somente tiles de vídeo; o de avatar já mostra o nome no quadrado) */}
      {tile.hasVideo && (
        <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px]">
          {tile.name} {tile.isLocal && !micOn ? '· mudo' : tile.muted ? '· 🔇' : ''}
        </span>
      )}

      {/* controles do tile (somente vídeo) */}
      {tile.hasVideo && (
        <div className="absolute right-2 top-2 flex gap-1.5">
          <button
            title="Tela cheia (todo o computador / celular)"
            onClick={() => toggleTileFullscreen(tile.id)}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-sm transition hover:bg-black/70"
          >
            ⛶
          </button>
        </div>
      )}

      {/* botão mudo para tile remoto */}
      {!tile.isLocal && (
        <button
          title={tile.muted ? 'Desmutar' : 'Mutar'}
          onClick={() => {
            const peerId = tile.peerId as string
            const next = !(mutedPeers[peerId] ?? false)
            setMutedPeers((prev) => ({ ...prev, [peerId]: next }))
            if (isAdmin) {
              void apiClient.post('/api/rtc', {
                action: 'admin-mute',
                targetId: peerId,
                muted: next,
              })
            }
          }}
          className={`absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg text-sm backdrop-blur transition ${
            tile.muted ? 'bg-red-500/80 hover:bg-red-500' : 'bg-black/50 hover:bg-black/70'
          }`}
        >
          {tile.muted ? '🔇' : '🔊'}
        </button>
      )}
    </div>
  )

  const renderMain = () => {
    if (!inCall) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="text-5xl">🎧</div>
          <h2 className="mt-4 text-xl font-bold">Escolha um canal de voz</h2>
          <p className="mt-2 max-w-md text-sm text-slate-400">
            Vá até a aba <span className="font-semibold text-indigo-300">Salas</span> e toque num
            canal para entrar na chamada.
          </p>
          <button
            onClick={() => setMobileTab('salas')}
            className="mt-4 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 md:hidden"
          >
            Ver salas
          </button>
        </div>
      )
    }
    const screenTiles = tiles.filter((t) => t.isScreen)
    const normalTiles = tiles.filter((t) => !t.isScreen)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto py-2">
        {screenTiles.length > 0 && (
          <div className="mt-auto flex items-center justify-center">
            {screenTiles.map((tile) => renderTile(tile))}
          </div>
        )}
        {normalTiles.length > 0 && (
          <div className="flex min-h-0 flex-wrap content-center items-center justify-center gap-3">
            {normalTiles.map((tile) => renderTile(tile))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`theme-${settings.theme} flex min-h-dvh flex-col gap-3 p-3 pb-24 md:h-screen md:grid md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:grid-rows-[minmax(0,auto)_minmax(0,1fr)] md:overflow-hidden md:pb-3`}
      onClick={() => {
        setViewProfile(null)
        setProfileMenuMsg(null)
      }}
    >
      <Toaster position="top-center" theme="dark" />

      {/* Sidebar */}
      <aside
        className={`share-panel flex min-h-0 flex-1 flex-col rounded-2xl p-3 md:col-start-1 md:row-start-1 md:overflow-y-auto ${
          mobileTab === 'salas' ? 'flex' : 'hidden'
        } md:flex`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xl font-extrabold tracking-tight">ShareRoom</span>
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">voz</span>
        </div>
        <p className="mt-1 text-xs text-slate-400">Canais de voz para conversar</p>

        {/* Mini perfil compacto + botão editar */}
        <div className="share-panel-soft mt-4 flex items-center gap-2 rounded-lg px-2 py-1.5">
          <Avatar name={profile.name || name} photo={profile.photo} size={30} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {profile.name || name}
          </span>
          <button
            title="Configurações do perfil"
            onClick={() => setEditProfileOpen(true)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs transition hover:bg-white/20"
          >
            ⚙️
          </button>
          <div
            role="button"
            tabIndex={0}
            title="Configurações"
            onClick={() => setSettingsOpen((o) => !o)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSettingsOpen((o) => !o) }}
            className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs transition ${
              settingsOpen ? 'bg-white/20' : 'hover:bg-white/20'
            }`}
          >
            🛠️
          </div>
        </div>

        <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Canais de voz
        </h3>
        <div className="mt-2 space-y-1.5 overflow-auto">
          {DEFAULT_CHANNELS.map((c) => {
            const active = inCall && channel === c.id
            const count = onlineMembers.filter(
              (m) => m.channel === c.id && m.clientId !== clientId
            ).length
            return (
              <button
                key={c.id}
                onClick={() => void joinChannel(c.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                  active
                    ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/40'
                    : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <span className="text-base">{active ? '🔊' : '🔈'}</span>
                <span className="flex-1 truncate">{c.label}</span>
                <span className="text-[10px] text-slate-400">{count} online</span>
              </button>
            )
          })}
        </div>

        <div className="mt-3">
          <button
            onClick={leaveChannel}
            disabled={!inCall}
            className="w-full rounded-lg bg-red-500/90 px-3 py-2 text-sm font-semibold text-white transition enabled:hover:bg-red-500 disabled:opacity-40"
          >
            Sair do canal
          </button>
        </div>

        <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Online ({onlineMembers.length})
        </h3>
        <div className="mt-2 space-y-1 overflow-auto">
          {onlineMembers.map((m) => (
            <div
              key={m.clientId}
              className="group flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-white/5"
            >
              <Avatar name={m.name} photo={m.photo} size={26} />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  m.channel === channel ? 'bg-emerald-400' : 'bg-slate-500'
                }`}
              />
              <button
                title="Ver perfil"
                onClick={(e) => {
                  e.stopPropagation()
                  setViewProfile({ name: m.name, photo: m.photo, bio: m.bio })
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-white/5 hover:text-slate-200"
              >
                ⋯
              </button>
            </div>
          ))}
        </div>

        {/* Limpeza de perfis fantasma / offline */}
        <div className="mt-3 space-y-2">
          <button
            onClick={() => resetMyName()}
            title="Escolhe de novo o seu nome, sem precisar abrir o perfil"
            className="w-full rounded-lg bg-emerald-500/20 px-3 py-2 text-left text-sm font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
          >
            ✏️ Trocar meu nome
          </button>
          <button
            onClick={() => void removeAllOffline()}
            disabled={offlineMembers.length === 0}
            title="Apaga usuários offline (fantasmas) para liberar os nomes e poder usá-los de novo"
            className="w-full rounded-lg bg-indigo-500/20 px-3 py-2 text-left text-sm font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition enabled:hover:bg-indigo-500/30 disabled:opacity-40 disabled:ring-transparent"
          >
            🔄 Resetar nomes dos perfis
          </button>
          {offlineMembers.length > 0 && (
            <div className="share-panel-soft rounded-lg p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                  Offline ({offlineMembers.length})
                </span>
                <button
                  onClick={() => void removeAllOffline()}
                  className="rounded-md bg-red-500/20 px-2 py-1 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/30"
                >
                  🗑 Excluir todas
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                Inativo há mais de 15 min · apague o registro para liberar o nome.
              </p>
              <ul className="mt-1.5 space-y-1">
                {offlineMembers.map((m) => (
                  <li key={m.clientId} className="flex items-center gap-2 text-xs text-slate-400">
                    <Avatar name={m.name} photo={m.photo} size={20} />
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {typeof m.lastSeen === 'number' && (
                      <span
                        translate="no"
                        title="Há quanto tempo saiu"
                        className="shrink-0 text-[10px] tabular-nums text-slate-500"
                      >
                        {formatAgo(m.lastSeen)}
                      </span>
                    )}
                    <button
                      title="Ver perfil"
                      onClick={(e) => {
                        e.stopPropagation()
                        setViewProfile({ name: m.name, photo: m.photo, bio: m.bio })
                      }}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-white/10 hover:text-slate-200"
                    >
                      ⋯
                    </button>
                    <button
                      title="Apagar registro offline"
                      onClick={() => void removeOfflineMember(m.clientId)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-white/10 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </aside>

      {/* Palco de vídeo */}
      <main
        className={`share-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl p-3 md:col-start-2 md:row-span-2 md:row-start-1 md:min-h-0 lg:min-h-0 ${
          mobileTab === 'chamadas' ? 'flex' : 'hidden'
        } md:flex`}
      >
        {renderMain()}

        {/* Configurações (Tema + Administrador) no canto superior direito */}
        {settingsOpen && (
          <div className="share-panel absolute right-3 top-3 z-30 flex w-64 flex-col rounded-xl p-1 shadow-2xl">
            <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
              <span className="text-sm font-bold">Configurações</span>
              <button
                onClick={() => setSettingsOpen(false)}
                title="Fechar"
                className="flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-xs transition hover:bg-white/20"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
              <span className="text-sm font-medium">Tema</span>
              <button
                role="switch"
                aria-checked={settings.theme === 'light'}
                title={settings.theme === 'light' ? 'Mudar para tema escuro' : 'Mudar para tema claro'}
                onClick={() => setSetting('theme', settings.theme === 'light' ? 'dark' : 'light')}
                className={`relative h-5 w-9 rounded-full transition ${
                  settings.theme === 'light' ? 'bg-amber-400' : 'bg-slate-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                    settings.theme === 'light' ? 'left-4' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
              <span className="text-sm font-medium">Administrador</span>
              {!adminOn ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    const v = new FormData(e.currentTarget).get('adminPwd')
                    void turnAdminOn(String(v))
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    name="adminPwd"
                    type="password"
                    placeholder="Senha"
                    autoComplete="current-password"
                    className="h-6 w-24 rounded border border-white/20 bg-white/5 px-1 text-xs outline-none"
                  />
                  <button
                    type="submit"
                    title="Enviar senha"
                    className="flex h-6 w-6 items-center justify-center rounded bg-emerald-500/20 text-xs transition hover:bg-emerald-500/30"
                  >
                    →
                  </button>
                </form>
              ) : (
                <button
                  role="switch"
                  aria-checked={isAdmin}
                  title={isAdmin ? 'Desativar modo administrador' : 'Ativar modo administrador'}
                  onClick={() => setIsAdmin((o) => !o)}
                  className={`relative h-5 w-9 rounded-full transition ${
                    isAdmin ? 'bg-emerald-500' : 'bg-slate-600'
                  }`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${isAdmin ? 'left-4' : 'left-0.5'}`} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Barra de controle (só quando estiver numa sala de voz) */}
        {inCall && (
          <>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={toggleMic}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
              micOn
                ? 'bg-white/10 text-white hover:bg-white/15'
                : 'bg-red-500/90 text-white hover:bg-red-500'
            }`}
          >
            {micOn ? '🎙️ Microfone' : '🔇 Mudo'}
          </button>
          <button
            onClick={toggleCam}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
          >
            {camOn ? '📷 Câmera ligada' : '📷 Ligar câmera'}
          </button>
          <button
            onClick={() => void toggleScreen()}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
          >
            {screenStreaming ? '🖥️ Parar tela' : '🖥️ Compartilhar tela'}
          </button>
          <select
            value={quality}
            onChange={(e) => setQualityAndApply(e.target.value as Quality)}
            title="Qualidade do vídeo/tela"
            className="h-9 rounded-lg border border-white/10 bg-slate-800/80 px-2 text-sm outline-none"
          >
            {QUALITY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-center text-[10px] text-slate-500">
          Qualidade atual:{QUALITY_OPTIONS.find((o) => o.id === quality)?.hint} · use Baixa p/ travar menos
        </p>
          </>
        )}
      </main>

      {/* Chat do canal */}
      <aside
        className={`share-panel flex min-h-0 flex-1 flex-col rounded-2xl p-4 md:col-start-1 md:row-start-2 md:min-h-0 ${
          mobileTab === 'chat' ? 'flex' : 'hidden'
        } md:flex`}
      >
        {!inCall ? (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <span className="text-3xl">🔒</span>
            <p className="mt-3 text-sm text-slate-400">
              Entre em um canal de voz para conversar no chat.
            </p>
          </div>
        ) : (
          <>
            <h3 className="text-sm font-semibold">Chat do canal · {channelLabel(channel)}</h3>
            <div className="relative mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {chat.map((m) => (
                <div key={m.id} className="share-panel-soft group relative rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[11px] text-slate-400">
                      <strong className="text-indigo-300">{m.author}</strong> · {new Date(m.time).toLocaleTimeString()}
                    </p>
                    <button
                      title="Opções da mensagem"
                      onClick={(e) => {
                        e.stopPropagation()
                        setProfileMenuMsg(profileMenuMsg === m.id ? null : m.id)
                      }}
                      className="shrink-0 text-slate-500 opacity-0 transition group-hover:opacity-100"
                    >
                      ⋯
                    </button>
                  </div>

                  {m.type === 'voice' ? (
                    <div className="mt-1.5 flex items-center gap-2 rounded-xl bg-indigo-500/15 p-2 ring-1 ring-indigo-400/20">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/30 text-base">🎤</span>
                      <audio controls preload="none" src={m.audioUrl} className="h-10 max-w-[180px] flex-1" />
                    </div>
                  ) : (
                    <p className="mt-0.5 break-words text-sm">{m.text}</p>
                  )}

                  {profileMenuMsg === m.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="share-panel absolute right-2 top-8 z-20 flex w-60 flex-col overflow-hidden rounded-xl p-1 shadow-2xl"
                    >
                      <button
                        onClick={() => {
                          setViewProfile({ name: m.author, photo: m.photo, bio: m.bio })
                          setProfileMenuMsg(null)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5"
                      >
                        👤 Ver perfil
                      </button>
                      <button
                        onClick={() => {
                          deleteForMe(m.id)
                          setProfileMenuMsg(null)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5"
                      >
                        🙈 Apagar para mim
                      </button>
                      <button
                        onClick={() => {
                          deleteChat(m.id)
                          setProfileMenuMsg(null)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-red-400 hover:bg-white/5"
                      >
                        🗑️ Apagar para todos
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Indicador de gravação */}
            {recording && (
              <div className="mt-2 flex shrink-0 items-center gap-2 rounded-xl bg-red-500/15 p-2 ring-1 ring-red-400/30">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                </span>
                <span className="flex-1 text-xs text-red-200">Gravando mensagem de voz...</span>
                <button
                  onClick={stopRecording}
                  className="rounded-lg bg-red-500 px-2 py-1 text-xs font-semibold text-white"
                >
                  Parar e enviar
                </button>
                <button
                  onClick={cancelRecording}
                  className="rounded-lg bg-white/10 px-2 py-1 text-xs text-slate-300"
                >
                  Cancelar
                </button>
              </div>
            )}

            <form
              className="mt-2 flex shrink-0 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                sendChat()
              }}
            >
              <button
                type="button"
                title={recording ? 'Gravando...' : 'Gravar mensagem de voz'}
                onClick={() => (recording ? stopRecording() : void startRecording())}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg transition ${
                  recording ? 'animate-pulse bg-red-500 text-white' : 'bg-white/10 hover:bg-white/15'
                }`}
              >
                🎤
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Escreva uma mensagem..."
                className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-800/60 px-3 text-sm outline-none focus:border-indigo-400/50"
              />
              <button
                type="submit"
                className="h-10 rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white transition hover:bg-indigo-400"
              >
                Enviar
              </button>
            </form>
          </>
        )}
      </aside>

      {/* Modais */}
      <ProfileEditModal
        open={editProfileOpen}
        profile={profile}
        onClose={() => setEditProfileOpen(false)}
        onSave={(next) => {
          void saveProfile(next)
        }}
      />
      {viewProfile && (
        <ProfileViewModal profile={viewProfile} onClose={() => setViewProfile(null)} />
      )}

      {/* Barra inferior de categorias (só mobile) */}
      <nav className="share-panel fixed inset-x-3 bottom-3 z-40 flex items-center gap-1 rounded-2xl p-2 shadow-2xl md:hidden">
        <button
          onClick={() => setMobileTab('salas')}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'salas' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">🗂️</span>
          Salas
        </button>
        <button
          onClick={() => setMobileTab('chamadas')}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'chamadas' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">{inCall ? '🔊' : '🎧'}</span>
          Chamadas
        </button>
        <button
          onClick={() => setMobileTab('chat')}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'chat' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">💬</span>
          Chat
        </button>
        <button
          onClick={() => {
            setConfigPane('menu')
            setMobileTab('config')
          }}
          className={`flex w-16 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'config' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">⚙️</span>
          Config
        </button>
      </nav>

      {/* Painel de Configurações no mobile (perfil + avançadas) */}
      {mobileTab === 'config' && (
        <div className="share-panel fixed inset-3 z-40 flex flex-col overflow-hidden rounded-2xl p-4 md:hidden">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {configPane !== 'menu' && (
                <button
                  onClick={() => setConfigPane('menu')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-slate-300 transition hover:bg-white/15"
                  aria-label="Voltar"
                >
                  ←
                </button>
              )}
              <h3 className="text-base font-bold">
                {configPane === 'menu'
                  ? 'Configurações'
                  : configPane === 'perfil'
                    ? 'Perfil'
                    : configPane === 'avancado'
                      ? 'Configurações avançadas'
                      : configPane === 'audio'
                        ? 'Áudio e vídeo'
                        : configPane === 'aparencia'
                          ? 'Aparência'
                          : configPane === 'notificacoes'
                            ? 'Notificações'
                            : configPane === 'silencioso'
                              ? 'Modo silencioso'
                              : configPane === 'idioma'
                                ? 'Idioma'
                                : configPane === 'limpeza'
                                  ? 'Limpeza'
                                  : 'Sobre'}
              </h3>
            </div>
            <button
              onClick={() => setMobileTab('salas')}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/15"
            >
              Fechar
            </button>
          </div>

          {configPane === 'menu' ? (
            <div className="mt-4 flex flex-col gap-3 overflow-y-auto no-scrollbar">
              {(
                [
                  ['perfil', '👤', 'bg-indigo-500/20', 'Perfil', 'Seu nome, bio e foto'],
                  ['audio', '🎙️', 'bg-sky-500/15', 'Áudio e vídeo', 'Volume, ruído, eco e qualidade'],
                  ['aparencia', '🎨', 'bg-fuchsia-500/15', 'Aparência', 'Tema escuro ou claro'],
                  ['notificacoes', '🔔', 'bg-amber-500/15', 'Notificações', 'Aviso quando alguém entra'],
                  ['silencioso', '🤫', 'bg-slate-500/15', 'Modo silencioso', 'Entrar sem ligar o microfone'],
                  ['idioma', '🌐', 'bg-emerald-500/15', 'Idioma', 'Português ou inglês'],
                  ['limpeza', '🧹', 'bg-red-500/15', 'Limpeza', 'Excluir offline e restaurar padrão'],
                  ['sobre', 'ℹ️', 'bg-cyan-500/15', 'Sobre', 'Nome, créditos e versão'],
                  ['avancado', '🛠️', 'bg-emerald-500/15', 'Configurações avançadas', 'Administrador e mais'],
                ] as const
              ).map(([id, icon, bg, label, desc]) => (
                <button
                  key={id}
                  onClick={() => setConfigPane(id)}
                  className="share-panel-soft flex items-center gap-3 rounded-xl p-4 text-left transition hover:bg-white/5"
                >
                  <span
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${bg} text-xl`}
                  >
                    {icon}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-slate-400">{desc}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto no-scrollbar pb-2">
              {/* Perfil */}
              {configPane === 'perfil' && (
                <section className="share-panel-soft flex flex-col gap-3 rounded-xl p-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/20 text-xl">
                      👤
                    </span>
                    <div>
                      <div className="text-sm font-semibold">{profile.name || 'Sem nome'}</div>
                      <div className="text-xs text-slate-400">Seu perfil público nas salas</div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setEditProfileOpen(true)
                      setMobileTab('salas')
                    }}
                    className="w-full rounded-xl bg-indigo-500/20 px-4 py-3 text-left text-sm font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/30"
                  >
                    ✏️ Editar perfil
                  </button>
                  <button
                    onClick={() => resetMyName()}
                    className="w-full rounded-xl bg-emerald-500/20 px-4 py-3 text-left text-sm font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
                  >
                    ✏️ Trocar meu nome
                  </button>
                </section>
              )}

              {/* Áudio e vídeo */}
              {configPane === 'audio' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🎙️ Áudio e vídeo</h4>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-400">Volume do som</span>
                  <span className="text-xs tabular-nums text-slate-300">{Math.round(settings.volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.volume * 100)}
                  onChange={(e) => setSetting('volume', Number(e.target.value) / 100)}
                  className="w-full accent-indigo-400"
                  aria-label="Volume do som"
                />
                {(
                  [
                    ['noiseSuppression', 'Redução de ruído'],
                    ['echoCancellation', 'Cancelamento de eco'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    role="switch"
                    aria-checked={settings[key]}
                    onClick={() => setSetting(key, !settings[key])}
                    className="flex w-full items-center justify-between py-1.5 text-left"
                  >
                    <span className="text-sm">{label}</span>
                    <span
                      className={`relative h-5 w-9 rounded-full transition ${
                        settings[key] ? 'bg-emerald-500' : 'bg-slate-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                          settings[key] ? 'left-4' : 'left-0.5'
                        }`}
                      />
                    </span>
                  </button>
                ))}
                <label className="mt-1 block text-xs text-slate-400">Qualidade padrão</label>
                <select
                  value={settings.defaultQuality}
                  onChange={(e) => setSetting('defaultQuality', e.target.value as Quality)}
                  className="mt-1 w-full rounded-lg border border-white/20 bg-white/5 px-2 py-2 text-sm outline-none"
                >
                  <option value="auto">Automática</option>
                  <option value="alta">Alta</option>
                  <option value="media">Média</option>
                  <option value="baixa">Baixa</option>
                </select>
              </section>
              )}

              {/* Aparência */}
              {configPane === 'aparencia' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🎨 Aparência</h4>
                <SwitchRow
                  checked={settings.theme === 'light'}
                  onChecked={(v) => setSetting('theme', v ? 'light' : 'dark')}
                  title={settings.theme === 'light' ? 'Tema claro' : 'Tema escuro'}
                />
              </section>
              )}

              {/* Notificações */}
              {configPane === 'notificacoes' && (
              <section className="share-panel-soft rounded-xl p-3">
                <SwitchRow
                  checked={settings.notifications}
                  onChecked={(v) => {
                    setSetting('notifications', v)
                    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                      void Notification.requestPermission()
                    }
                  }}
                  title="Notificações"
                  desc="Aviso quando alguém entra na sala"
                />
              </section>
              )}

              {/* Modo silencioso */}
              {configPane === 'silencioso' && (
              <section className="share-panel-soft rounded-xl p-3">
                <SwitchRow
                  checked={settings.silentMode}
                  onChecked={(v) => setSetting('silentMode', v)}
                  title="Modo silencioso"
                  desc="Entrar nas salas sem ativar o microfone"
                />
              </section>
              )}

              {/* Idioma */}
              {configPane === 'idioma' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🌐 Idioma</h4>
                <div className="flex gap-1 rounded-lg bg-white/5 p-1">
                  {(['pt', 'en'] as const).map((lang) => (
                    <button
                      key={lang}
                      onClick={() => setSetting('language', lang)}
                      className={`flex-1 rounded-md py-1.5 text-sm font-semibold transition ${
                        settings.language === lang ? 'bg-indigo-500/40' : 'text-slate-400'
                      }`}
                    >
                      {lang === 'pt' ? 'Português' : 'English'}
                    </button>
                  ))}
                </div>
              </section>
              )}

              {/* Limpeza */}
              {configPane === 'limpeza' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🧹 Limpeza</h4>
                <button
                  onClick={() => void removeAllOffline()}
                  disabled={offlineMembers.length === 0}
                  className="w-full rounded-lg bg-red-500/15 px-3 py-2 text-left text-sm font-semibold text-red-300 ring-1 ring-red-400/30 transition enabled:hover:bg-red-500/25 disabled:opacity-40 disabled:ring-transparent"
                >
                  🗑 Excluir perfis offline ({offlineMembers.length})
                </button>
                <button
                  onClick={() => {
                    try {
                      localStorage.removeItem(SETTINGS_KEY)
                      setSettings(DEFAULT_SETTINGS)
                    } catch {
                      /* noop */
                    }
                  }}
                  className="mt-2 w-full rounded-lg bg-white/5 px-3 py-2 text-left text-sm font-semibold text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10"
                >
                  ↩️ Restaurar preferências padrão
                </button>
              </section>
              )}

              {/* Sobre */}
              {configPane === 'sobre' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">ℹ️ Sobre</h4>
                <p className="text-sm">
                  ShareRoom — canais de voz e vídeo para encontrar pessoas e conversar.
                </p>
                <p className="mt-1 text-xs text-slate-400">Criado por Noah · Versão inicial</p>
              </section>
              )}

              {/* Admin */}
              {configPane === 'avancado' && (
              <>
              <div className="share-panel-soft flex items-center justify-between gap-2 rounded-xl p-3">
                <span className="text-sm font-medium">Administrador</span>
                {!adminOn ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      const v = new FormData(e.currentTarget).get('adminPwd')
                      void turnAdminOn(String(v))
                    }}
                    className="flex items-center gap-1"
                  >
                    <input
                      name="adminPwd"
                      type="password"
                      placeholder="Senha"
                      autoComplete="current-password"
                      className="h-8 w-28 rounded border border-white/20 bg-white/5 px-2 text-xs outline-none"
                    />
                    <button
                      type="submit"
                      title="Enviar senha"
                      className="flex h-8 w-8 items-center justify-center rounded bg-emerald-500/20 text-xs transition hover:bg-emerald-500/30"
                    >
                      →
                    </button>
                  </form>
                ) : (
                  <button
                    role="switch"
                    aria-checked={isAdmin}
                    title={isAdmin ? 'Desativar modo administrador' : 'Ativar modo administrador'}
                    onClick={() => setIsAdmin((o) => !o)}
                    className={`relative h-5 w-9 rounded-full transition ${
                      isAdmin ? 'bg-emerald-500' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        isAdmin ? 'left-4' : 'left-0.5'
                      }`}
                    />
                  </button>
                )}
              </div>

              <button
                onClick={() => resetMyName()}
                className="w-full rounded-xl bg-emerald-500/20 px-4 py-3 text-left text-sm font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
              >
                ✏️ Trocar meu nome
              </button>
              <button
                onClick={() => void removeAllOffline()}
                disabled={offlineMembers.length === 0}
                className="w-full rounded-xl bg-indigo-500/20 px-4 py-3 text-left text-sm font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition enabled:hover:bg-indigo-500/30 disabled:opacity-40 disabled:ring-transparent"
              >
                🔄 Resetar nomes dos perfis
              </button>
              {offlineMembers.length > 0 && (
                <button
                  onClick={() => void removeAllOffline()}
                  className="w-full rounded-xl bg-red-500/15 px-4 py-3 text-left text-sm font-semibold text-red-300 ring-1 ring-red-400/30 transition hover:bg-red-500/25"
                >
                  🗑 Excluir todos os offline ({offlineMembers.length})
                </button>
              )}
              </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
