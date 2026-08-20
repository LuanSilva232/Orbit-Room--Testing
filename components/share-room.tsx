'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast, Toaster } from 'sonner'

import { deviceAuthed, setDeviceAuthed } from './consent-banner'
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

import { AnonProfileModal, Avatar, ProfileEditModal } from './modals'
import { ProfileViewModal } from './profile-popup'
import { FriendsPanel } from './friends-panel'
import { FriendsOnline } from './friends-online'

const OFFLINE_MS = 15 * 60 * 1000 // 15min sem atividade = offline ("fantasma")

const CLIENT_KEY = 'share_room_client_id'
const PROFILE_KEY = 'share_room_profile'
const NOTIFY_ASKED_KEY = 'share_room_notify_asked'

// Identidade anônima persistente por dispositivo: além do localStorage, o ID é
// guardado no IndexedDB para que o mesmo navegador/celular "lembre" da mesma
// conta anônima mesmo se o localStorage for limpo — evitando duplicar contas.
const IDB_NAME = 'share_room_device'
const IDB_STORE = 'kv'

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no-idb'))
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key: string): Promise<string | null> {
  try {
    const db = await openIdb()
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const rq = tx.objectStore(IDB_STORE).get(key)
      rq.onsuccess = () => resolve(typeof rq.result === 'string' ? rq.result : null)
      rq.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function idbSet(key: string, value: string): Promise<void> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* noop */
  }
}

type Remote = { name: string; streams: MediaStream[] }

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
  simulated?: boolean
}

const QUALITY_CONSTRAINTS: Record<Quality, MediaTrackConstraints> = {
  auto: {},
  baixa: { frameRate: { max: 15, ideal: 15 }, width: { max: 640, ideal: 640 } },
  media: { frameRate: { max: 24, ideal: 24 }, width: { max: 960, ideal: 960 } },
  alta: { frameRate: { max: 30, ideal: 30 }, width: { max: 1280, ideal: 1280 } },
}

// Limite de taxa de bits (bps) de envio por qualidade. Evita que o upload de
// tela sature a conexão e cause travadas para quem está assistindo.
const QUALITY_BITRATES: Record<Quality, number> = {
  auto: 0, // sem limite
  baixa: 600_000, // ~600 kbps
  media: 1_200_000, // ~1.2 Mbps
  alta: 2_500_000, // ~2.5 Mbps
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

// Traduções PT/EN dos textos mais visíveis da interface.
const STRINGS = {
  subtitle: ['Canais de voz para conversar', 'Voice channels to talk'],
  channels: ['Canais de voz', 'Voice channels'],
  online: ['Online', 'Online'],
  noOnline: ['Ninguém online por enquanto', 'No one online yet'],
  onlinePeople: ['Amigos online', 'Friends online'],
  onlinePeopleDesc: ['Só os seus amigos (online e offline)', 'Only your friends (online and offline)'],
  friendsOnline: ['Amigos online', 'Friends online'],
  amigos: ['Convites', 'Invites'],
  amigosDesc: ['Enviar/aceitar convites e copiar seu código', 'Send/accept invites and copy your code'],
  amigosLocked: ['Login com Google obrigatório', 'Google sign-in required'],
  amigosLockedHint: [
    'Para gerenciar amigos e convites, entre com sua conta Google.',
    'To manage friends and invites, sign in with your Google account.',
  ],
  leaveChannel: ['Sair do canal', 'Leave channel'],
  changeName: ['Trocar meu nome', 'Change my name'],
  chooseChannel: ['Escolha um canal de voz', 'Choose a voice channel'],
  chooseHintFull: [
    'Vá até a aba Salas e toque num canal para entrar na chamada.',
    'Go to the Rooms tab and tap a channel to join the call.',
  ],
  seeRooms: ['Ver salas', 'See rooms'],
  roomTab: ['Salas', 'Rooms'],
  homeTab: ['Início', 'Home'],
  publicRooms: ['Salas Públicas', 'Public Rooms'],
  privateRooms: ['Salas Privadas', 'Private Rooms'],
  createRoom: ['Criar salas', 'Create rooms'],
  myRooms: ['Minhas salas', 'My rooms'],
  publicRoomsDesc: ['Canais abertos para todo mundo', 'Open channels for everyone'],
  privateRoomsDesc: ['Salas fechadas por convite', 'Rooms closed by invite'],
  createRoomDesc: ['Crie a sua própria sala', 'Create your own room'],
  myRoomsDesc: ['As salas em que você participa', 'The rooms you take part in'],
  comingSoon: ['Em breve', 'Coming soon'],
  callTab: ['Chamadas', 'Calls'],
  chatTab: ['Chat', 'Chat'],
  configTab: ['Config', 'Settings'],
  configTitle: ['Configurações', 'Settings'],
  chatTitle: ['Chat do canal', 'Channel chat'],
  locked: [
    'Entre em um canal de voz para conversar no chat.',
    'Join a voice channel to talk in the chat.',
  ],
  writeMsg: ['Escreva uma mensagem...', 'Write a message...'],
  send: ['Enviar', 'Send'],
  micOn: ['Microfone', 'Microphone'],
  muted: ['Mudo', 'Muted'],
  camOn: ['Câmera ligada', 'Camera on'],
  camTurn: ['Ligar câmera', 'Turn on camera'],
  screenStop: ['Parar tela', 'Stop sharing'],
  screenShare: ['Compartilhar tela', 'Share screen'],
  screenAudio: ['Áudio na tela', 'Screen audio'],
  screenNoAudio: ['Sem áudio', 'No audio'],
  currentQuality: ['Qualidade atual', 'Current quality'],
  qualityHint: ['use Baixa p/ travar menos', 'use Low for less lag'],
  back: ['Voltar', 'Back'],
  close: ['Fechar', 'Close'],
  profile: ['Perfil', 'Profile'],
  audioVideo: ['Áudio e vídeo', 'Audio & video'],
  appearance: ['Aparência', 'Appearance'],
  notifications: ['Notificações', 'Notifications'],
  silentMode: ['Modo silencioso', 'Silent mode'],
  language: ['Idioma', 'Language'],
  cleanup: ['Limpeza', 'Cleanup'],
  about: ['Sobre', 'About'],
  advanced: ['Configurações avançadas', 'Advanced settings'],
  voice: ['voz', 'voice'],
  editProfile: ['Editar perfil', 'Edit profile'],
  noName: ['Sem nome', 'No name'],
  publicProfile: ['Seu perfil público nas salas', 'Your public profile in rooms'],
  volume: ['Volume do som', 'Sound volume'],
  micVolume: ['Volume do microfone', 'Microphone volume'],
  noiseEcho: ['Ruído e eco', 'Noise and echo'],
  cancelEcho: ['Cancelamento de eco', 'Echo cancellation'],
  noiseSup: ['Supressão de ruído', 'Noise suppression'],
  perfilDesc: ['Seu nome, bio e foto', 'Your name, bio and photo'],
  audioDesc: ['Volume, ruído, eco e qualidade', 'Volume, noise, echo and quality'],
  aparenciaDesc: ['Tema escuro ou claro', 'Dark or light theme'],
  notificacoesDesc: ['Aviso quando alguém entra', 'Notify when someone joins'],
  silenciosoDesc: ['Entrar sem ligar o microfone', 'Join without enabling mic'],
  idiomaDesc: ['Português ou inglês', 'Portuguese or English'],
  limpezaDesc: ['Excluir offline e restaurar padrão', 'Remove offline and reset defaults'],
  sobreDesc: ['Nome, créditos e versão', 'Name, credits and version'],
  avancadoDesc: ['Administrador e mais', 'Admin and more'],
  account: ['Minha conta', 'My account'],
  accountDesc: ['Entrar com o Google e gerenciar sua conta', 'Sign in with Google and manage your account'],
  accountInfo: ['Suas informações da conta Google', 'Your Google account info'],
  accountEditHint: ['Para editar nome, foto e fundo, vá em Meu Perfil.', 'To edit name, photo and background, go to My Profile.'],
  revealEmail: ['Revelar e-mail', 'Reveal email'],
  hideEmail: ['Ocultar e-mail', 'Hide email'],
  deleteAccount: ['🗑 Excluir minha conta (em 3 dias)', '🗑 Delete my account (in 3 days)'],
  deleteAccountAnon: ['🗑 Excluir minha conta anônima (em 3 dias)', '🗑 Delete my anonymous account (in 3 days)'],
  deleteScheduled: ['Exclusão agendada', 'Deletion scheduled'],
  deleteCountdownHint: ['Sua conta será excluída definitivamente em', 'Your account will be permanently deleted in'],
  cancelDelete: ['Me arrependi — cancelar', 'I changed my mind — cancel'],
  deleteStillWorks: ['Você pode continuar usando sua conta normalmente até lá.', 'You can keep using your account normally until then.'],
  notConnected: ['Você não está conectado', 'You are not signed in'],
  accountSignInHint: ['Entre com o Google para salvar e sincronizar seu perfil.', 'Sign in with Google to save and sync your profile.'],
  signInGoogle: ['Entrar com o Google', 'Sign in with Google'],
  signOut: ['Sair da conta', 'Sign out'],
  lightTheme: ['Tema claro', 'Light theme'],
  darkTheme: ['Tema escuro', 'Dark theme'],
  notifyDesc: ['Aviso quando alguém entra na sala', 'Notify when someone joins the room'],
  notifyJoined: ['entrou em', 'joined'],
  notifyLeft: ['saiu de', 'left'],
  notifyBodyJoined: ['Um participante entrou na chamada.', 'A participant joined the call.'],
  notifyBodyLeft: ['Um participante saiu da chamada.', 'A participant left the call.'],
  notifyPromptTitle: ['Ativar notificações?', 'Enable notifications?'],
  notifyPromptDesc: ['Quer que o Orbit Room te avise quando alguém entra ou sai das chamadas, e quando estiver online?', 'Want Orbit Room to notify you when someone joins or leaves calls, and when online?'],
  notifyPromptYes: ['Sim, ativar', 'Yes, enable'],
  notifyPromptLater: ['Agora não', 'Not now'],
  seeMoreScreens: ['Ver mais telas', 'See more screens'],
  whoIsSharing: ['Compartilhando tela', 'Screen sharing'],
  screensSharing: ['compartilhando tela', 'sharing screen'],
  screenSimLabel: ['Simulação', 'Simulation'],
  addDemoScreen: ['Simular compartilhar', 'Simulate sharing'],
  clearDemo: ['Limpar', 'Clear'],
  demoBanner: ['Modo de teste — simulação de telas', 'Test mode — simulated screens'],
  screenMute: ['Mutar som da tela', 'Mute screen sound'],
  screenUnmute: ['Ativar som da tela', 'Unmute screen sound'],
  screenShort: ['tela', 'screen'],
  watchScreen: ['Assistir', 'Watch'],
  closeWatch: ['Fechar', 'Close'],
  soloKickedTitle: ['Você foi removido da sala', 'You were removed from the room'],
  soloKicked: [
    'Você ficou sozinho(a) no canal por mais de 5 minutos e foi removido(a) automaticamente para não deixar um perfil vazio.',
    'You were alone in the channel for over 5 minutes and were automatically removed to avoid leaving an empty profile.',
  ],
  gotIt: ['Entendi', 'Got it'],
  yes: ['Sim', 'Yes'],
  no: ['Não', 'No'],
  confirmDeleteTitle: ['Apagar mensagem', 'Delete message'],
  confirmDeleteMsg: [
    'Tem certeza que quer apagar esta mensagem?',
    'Are you sure you want to delete this message?',
  ],
  confirmClearTitle: ['Limpar conversa', 'Clear chat'],
  confirmClearMsg: [
    'Tem certeza que quer apagar todas as conversas deste chat? Isso não pode ser desfeito.',
    'Are you sure you want to delete all messages in this chat? This cannot be undone.',
  ],
  clearAllChats: ['Limpar todos os chats', 'Clear all chats'],
  clearAllChatsDesc: [
    'Escolha um chat para apagar todas as conversas',
    'Choose a chat to delete all conversations',
  ],
  chatClearedOk: ['Conversas apagadas', 'Chat cleared'],
  nowWatching: ['Assistindo agora', 'Watching now'],
  silentDesc: ['Entrar nas salas sem ativar o microfone', 'Join rooms without enabling the mic'],
  deleteOffline: ['Excluir perfis offline', 'Delete offline profiles'],
  deleteAllOffline: ['Excluir todos os offline', 'Delete all offline'],
  restorePrefs: ['Restaurar preferências padrão', 'Restore default preferences'],
  admin: ['Administrador', 'Admin'],
  password: ['Senha', 'Password'],
  noiseLabel: ['Ruído', 'Noise'],
  echoLabel: ['Eco', 'Echo'],
  aboutText: [
    'Orbit Room é um aplicativo de canais de voz e vídeo onde você entra em salas para conversar com outras pessoas em tempo real. Dentro de cada sala dá para falar pelo microfone, ligar a câmera, compartilhar a tela e trocar mensagens de texto com quem está online.\n\nFeito para reunir pessoas: entre numa sala, veja quem está por lá, converse à vontade e, se quiser, compartilhe o que está vendo. O Orbit Room nasceu para aproximar pessoas e facilitar conversas ao vivo — do jeito mais simples e direto.',
    'Orbit Room is a voice and video channels app where you join rooms to talk with other people in real time. Inside each room you can speak through the mic, turn on your camera, share your screen, and exchange text messages with whoever is online.\n\nMade to bring people together: join a room, see who is there, chat freely and, if you like, share what you are seeing. Orbit Room was created to bring people closer and make live conversations easy — in the simplest, most direct way.',
  ],
  aboutCredits: ['Criado por Noah · v0.5', 'Created by Noah · v0.5'],
} as const

function formatRemaining(until: number, now: number): string {
  const total = Math.max(0, Math.floor((until - now) / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days >= 1) return `${days}D ${hours}h`
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Contagem regressiva da exclusão (3 dias de carência). Atualiza sozinha a cada segundo.
function DeleteCountdown({ until }: { until: number }) {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <span translate="no" className="font-mono tabular-nums text-sm font-bold text-rose-200">
      {formatRemaining(until, now)}
    </span>
  )
}

export function ShareRoom() {
  const router = useRouter()
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
  const [screenWithAudio, setScreenWithAudio] = useState(false)
  const [quality, setQuality] = useState<Quality>('auto')

  const [profile, setProfile] = useState<Profile>({ name: '' })
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const [revealEmail, setRevealEmail] = useState(false)
  const [deleteScheduledAt, setDeleteScheduledAt] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const maskEmail = (e: string) => {
    const at = e.indexOf('@')
    if (at <= 0) return e
    const u = e.slice(0, at)
    const d = e.slice(at)
    const stars = u.length <= 3 ? '*'.repeat(u.length) : `${u.slice(0, 2)}${'*'.repeat(u.length - 2)}`
    return `${stars}${d}`
  }
  const [viewProfile, setViewProfile] = useState<(Profile & { userId?: string }) | null>(null)
  const [viewAnonProfile, setViewAnonProfile] = useState<{ name: string } | null>(null)
  const [profileMenuMsg, setProfileMenuMsg] = useState<string | null>(null)
  const [msgRelation, setMsgRelation] = useState<{
    isFriend: boolean
    isFollowing: boolean
    requestStatus: 'sent' | 'received' | null
  } | null>(null)

  const [mutedPeers, setMutedPeers] = useState<Record<string, boolean>>({})
  const [recording, setRecording] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [showNotifyPrompt, setShowNotifyPrompt] = useState(false)
  const [showMoreScreens, setShowMoreScreens] = useState(false)
  const [demoScreens, setDemoScreens] = useState<string[]>([])
  const [screenMuted, setScreenMuted] = useState<Record<string, boolean>>({})
  const [watchScreen, setWatchScreen] = useState<Tile | null>(null)
  const [kickNotice, setKickNotice] = useState(false)
  const [pendingDeleteMe, setPendingDeleteMe] = useState<string | null>(null)
  const [showClearChats, setShowClearChats] = useState(false)
  const [pendingClearChannel, setPendingClearChannel] = useState<ChannelId | null>(null)
  const [adminOn, setAdminOn] = useState(false)

  // ----- conta (login com Google) -----
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null>(null)
  const authUserRef = useRef<{ id: string; email: string } | null>(null)
  const setAuth = useCallback((u: { id: string; email: string } | null) => {
    authUserRef.current = u
    setAuthUser(u)
  }, [])

  // Contador de convites de amizade pendentes (selo vermelho na subcategoria Amigos).
  const [pendingCount, setPendingCount] = useState(0)

  // Categoria ativa no mobile (barra inferior). Desktop não usa.
  const [mobileTab, setMobileTab] = useState<'inicio' | 'chamadas' | 'chat' | 'config'>('inicio')
  const [inicioView, setInicioView] = useState<'home' | 'publicas' | 'privadas' | 'criar' | 'minhas'>('home')
  // Sub-tela do painel de Configurações no mobile (cada categoria abre a sua).
  const [configPane, setConfigPane] = useState<
    | 'menu'
    | 'conta'
    | 'perfil'
    | 'avancado'
    | 'audio'
    | 'aparencia'
    | 'notificacoes'
    | 'silencioso'
    | 'idioma'
    | 'limpeza'
    | 'sobre'
    | 'online'
    | 'amigos'
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

  // Na primeira visita, pergunta se o usuário quer ativar as notificações
  // (só pede uma vez; a escolha fica guardada).
  useEffect(() => {
    let asked = false
    try {
      asked = localStorage.getItem(NOTIFY_ASKED_KEY) === '1'
    } catch {
      /* noop */
    }
    if (
      !asked &&
      !settings.notifications &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    ) {
      setShowNotifyPrompt(true)
    }
  }, [settings.notifications])

  const acceptNotifyPrompt = useCallback(() => {
    try {
      localStorage.setItem(NOTIFY_ASKED_KEY, '1')
    } catch {
      /* noop */
    }
    setShowNotifyPrompt(false)
    setSetting('notifications', true)
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [setSetting])

  const dismissNotifyPrompt = useCallback(() => {
    try {
      localStorage.setItem(NOTIFY_ASKED_KEY, '1')
    } catch {
      /* noop */
    }
    setShowNotifyPrompt(false)
  }, [])

  // ----- Detecção de voz (anel verde quando alguém está falando) -----
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map())
  const speakersRef = useRef<Record<string, boolean>>({})
  const [speakers, setSpeakers] = useState<Record<string, boolean>>({})

  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctor =
        typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined
      if (Ctor) audioCtxRef.current = new Ctor()
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume()
    }
    return audioCtxRef.current
  }, [])

  // Retoma o contexto de áudio no primeiro toque/clique (exigência do navegador).
  useEffect(() => {
    const resume = () => ensureAudioCtx()
    window.addEventListener('pointerdown', resume)
    window.addEventListener('touchstart', resume)
    return () => {
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('touchstart', resume)
    }
  }, [ensureAudioCtx])

  // Traduz um texto para o idioma ativo (pt/en).
  const t = useCallback(
    (k: keyof typeof STRINGS) => STRINGS[k][settings.language === 'en' ? 1 : 0],
    [settings.language]
  )

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

  // Torna o usuário "online" no site (sem precisar entrar em uma sala).
  const registerPresence = useCallback(() => {
    if (!clientIdRef.current) return
    void apiClient.post('/api/rtc', {
      action: 'presence',
      clientId: clientIdRef.current,
      name: nameRef.current,
      photo: profileRef.current.photo,
      bio: profileRef.current.bio,
      cover: profileRef.current.cover,
    })
  }, [])

  const bind = useCallback((el: HTMLMediaElement | null, stream: MediaStream | null) => {
    if (!el || !stream) return
    if (el.srcObject !== stream) el.srcObject = stream
    // Guarda o elemento para aplicar mudanças de volume em tempo real.
    mediaElsRef.current.add(el)
    // Volume global do usuário (ajustado em Configurações → Áudio e vídeo).
    if (typeof el.volume === 'number') {
      el.volume = Math.max(0, Math.min(1, volumeRef.current))
    }
  }, [])

  // Ref para o volume, para que os elementos apliquem sempre o valor atual.
  const volumeRef = useRef<number>(1)
  volumeRef.current = settings.volume

  // Guarda os elementos de mídia (áudio/vídeo) já em reprodução, para que a
  // mudança de volume em Configurações valha na hora, sem precisar reconectar.
  const mediaElsRef = useRef<Set<HTMLMediaElement>>(new Set())

  // Aplica o volume atual em todos os participantes já tocando.
  useEffect(() => {
    const v = Math.max(0, Math.min(1, settings.volume))
    mediaElsRef.current.forEach((el) => {
      if (typeof el.volume === 'number') el.volume = v
    })
  }, [settings.volume])

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
  // Ordem de ativação dos compartilhamentos de tela (quem começou primeiro).
  const screenOrderRef = useRef<string[]>([])

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
    const bitrate = QUALITY_BITRATES[q]
    const engine = engineRef.current
    tracks.forEach((t) => {
      if (t.readyState !== 'live') return
      void t.applyConstraints(constraints).catch(() => undefined)
      if (bitrate > 0) void engine?.setTrackBitrate(t, bitrate)
    })
  }, [])

  const setQualityAndApply = useCallback(
    (q: Quality) => {
      setQuality(q)
      applyQualityToStreams(q)
    },
    [applyQualityToStreams]
  )

  const reacquire = useCallback(
    async (withVideo: boolean, keepMicMuted = false) => {
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
        // Se o microfone estava mudo, mantém mudo ao ativar câmera/tela.
        stream.getAudioTracks().forEach((t) => (t.enabled = !keepMicMuted))
        replaceLocalStream(stream)
        setMicOn(!keepMicMuted)
        applyQualityToStreams(settings.defaultQuality)
      } catch {
        toast.error('Não foi possível acessar microfone/câmera')
      }
    },
    [replaceLocalStream, settings.echoCancellation, settings.noiseSuppression, settings.defaultQuality, applyQualityToStreams]
  )

  // Quando o usuário liga/desliga o corte de ruído ou o eco, reaplica na hora
  // na chamada atual (sem precisar sair e entrar de novo).
  useEffect(() => {
    if (!inCallRef.current) return
    void reacquire(camOn, !micOn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.noiseSuppression, settings.echoCancellation])

  // ----- engine + polling -----
  useEffect(() => {
    let disposed = false
    let timer: number | null = null

    const teardown = () => {
      disposed = true
      if (timer != null) window.clearInterval(timer)
      engineRef.current?.closeAll()
    }

    ;(async () => {
      // ---- resolve a identidade (com backup no IndexedDB) ----
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
        sn = (oldName || '').trim()
      }
      if (!sn) sn = 'Anônimo'

      // Reutiliza o id salvo para não criar "fantasma" ao recarregar a página.
      // Se o localStorage foi limpo, recupera a MESMA identidade no IndexedDB,
      // para o mesmo dispositivo voltar com a mesma conta anônima (sem duplicar).
      let id = localStorage.getItem(CLIENT_KEY) || ''
      if (!id) id = (await idbGet(CLIENT_KEY)) || ''
      if (!id) {
        id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        localStorage.setItem(CLIENT_KEY, id)
        void idbSet(CLIENT_KEY, id)
      } else {
        localStorage.setItem(CLIENT_KEY, id)
      }

      // Persiste o perfil (nome / foto / bio) no navegador e no IndexedDB.
      const saved: Profile = {
        name: sn,
        photo: cachedProfile?.photo,
        bio: cachedProfile?.bio,
        cover: cachedProfile?.cover,
      }
      localStorage.setItem(PROFILE_KEY, JSON.stringify(saved))
      void idbSet(PROFILE_KEY, JSON.stringify(saved))

      if (disposed) return

      clientIdRef.current = id
      nameRef.current = sn
      setClientId(id)
      setName(sn)
      setProfile(saved)
      profileRef.current = saved
      registerPresence()

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
            new Notification(`${msg.member.name} ${t('notifyJoined')} ${channelLabel(channelRef.current)}`, {
              body: t('notifyBodyJoined'),
            })
          } catch {
            /* noop */
          }
        }
      } else if (msg.type === 'peer-left') {
        engine.removePeer(msg.clientId)
        // Notificação quando alguém sai da sala.
        if (settings.notifications && msg.clientId !== clientIdRef.current && document.hidden) {
          const name = remotePeersRef.current[msg.clientId]?.name ?? t('noName')
          try {
            new Notification(`${name} ${t('notifyLeft')} ${channelLabel(channelRef.current)}`, {
              body: t('notifyBodyLeft'),
            })
          } catch {
            /* noop */
          }
        }
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
      } else if (msg.type === 'chat-cleared') {
        // Todas as mensagens deste chat foram apagadas (limpeza).
        if (msg.channel === channelRef.current) {
          seenChatRef.current = new Set()
          setChat([])
        }
      } else if (msg.type === 'admin-mute') {
        setMutedPeers((prev) => ({ ...prev, [msg.targetId]: msg.muted }))
      } else if (msg.type === 'kicked') {
        // Foi desconectado por ficar sozinho no canal por 5 minutos (AFK).
        setKickNotice(true)
      } else if (msg.type === 'screen-kind') {
        screenTrackIdsRef.current = {
          ...screenTrackIdsRef.current,
          [msg.from]: msg.trackIds,
        }
        setRemotePeers({ ...remotePeersRef.current })
      }
    }

    let syncCount = 0

    const poll = async () => {
      if (disposed) return
      try {
        const res = await apiClient.get<{
          messages: MailboxMessage[]
          members: Member[]
          offlineMembers: Member[]
          deleteScheduledAt: number | null
        }>(`/api/rtc?action=mailbox&clientId=${clientIdRef.current}`)
        if (!res.success) return
        setOnlineMembers(res.data?.members ?? [])
        setOfflineMembers(res.data?.offlineMembers ?? [])
        // Prazo de exclusão (anônimos): sincroniza do servidor. Quem entrou com
        // Google usa o status da conta, então não sobrescreve pelo polling aqui.
        if (!authUserRef.current) {
          const dsa = res.data?.deleteScheduledAt ?? null
          setDeleteScheduledAt((prev) => (prev === dsa ? prev : dsa))
        }
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

    timer = window.setInterval(poll, 250)
    void poll()
    })()
    return teardown
  }, [sendSignalBody, settings.notifications, registerPresence])

  // ----- conta: carrega o usuário logado e o perfil salvo no servidor -----
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        const u = d?.user
        if (!u) {
          // Este aparelho já entrou com Google antes, mas a sessão expirou:
          // pede para entrar de novo em vez de recriar um anônimo do zero.
          if (deviceAuthed() && window.location.pathname !== '/login') {
            window.location.replace('/login')
          }
          return
        }
        setAuth({ id: u.id, email: u.email })
        // Este aparelho já entrou com Google: marca para retomar o login depois.
        setDeviceAuthed()
        // Carrega se há exclusão agendada para esta conta (status).
        fetch('/api/account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'status' }),
        })
          .then((r) => r.json())
          .then((s) => {
            if (cancelled) return
            if (typeof s?.deleteScheduledAt === 'number') setDeleteScheduledAt(s.deleteScheduledAt)
            else if (s?.deleteScheduledAt === null) setDeleteScheduledAt(null)
          })
          .catch(() => {})
        // Puxa o perfil salvo (nome, bio, foto) da conta.
        return fetch('/api/profile')
          .then((r) => r.json())
          .then((p) => {
            if (cancelled || !p?.profile) return
            const prof = p.profile as { name?: string; bio?: string | null; photo?: string | null; cover?: string | null }
            // O perfil salvo no servidor tem dados? (conta nova fica em branco)
            const serverHasData =
              !!(prof.name?.trim() && prof.name.trim() !== 'Anônimo') ||
              !!prof.photo ||
              !!prof.bio ||
              !!prof.cover
            // O que o usuário já tinha preenchido localmente antes do login?
            let local: Profile | null = null
            try {
              const raw = localStorage.getItem(PROFILE_KEY)
              if (raw) local = JSON.parse(raw) as Profile
            } catch {
              local = null
            }
            const localHasData = !!local && !!(local.name && local.name !== 'Anônimo')
            let next: Profile
            if (!serverHasData && localHasData && local) {
              // Conta recém-criada: aproveita o perfil local e salva automaticamente.
              next = local
            } else {
              next = {
                name: prof.name?.trim() || 'Anônimo',
                photo: prof.photo ?? undefined,
                bio: prof.bio ?? undefined,
                cover: prof.cover ?? undefined,
              }
            }
            profileRef.current = next
            setProfile(next)
            if (next.name) {
              nameRef.current = next.name
              setName(next.name)
            }
            try {
              localStorage.setItem(PROFILE_KEY, JSON.stringify(next))
            } catch {
              /* ignore */
            }
            // Garante que o perfil local é persistido na conta ao entrar.
            if (!serverHasData && localHasData && local) {
              void fetch('/api/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: next.name, bio: next.bio, photo: next.photo, cover: next.cover }),
              }).catch(() => {})
            }
            // Atualiza a presença online com o nome/foto reais da conta logada.
            registerPresence()
          })
      })
      .catch(() => {
        /* offline / sessão ausente — segue com perfil local */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- selo de convites pendentes (Amigos) -----
  useEffect(() => {
    if (!authUser) {
      setPendingCount(0)
      return
    }
    let stop = false
    const poll = () => {
      fetch('/api/social')
        .then((r) => r.json())
        .then((d) => {
          if (stop) return
          const n = Array.isArray(d?.requests) ? d.requests.length : 0
          setPendingCount(n)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 8000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [authUser])

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
      // Garante que o compartilhamento de tela é totalmente desligado ao trocar de sala.
      setScreenStreaming(false)
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop())
        screenStreamRef.current = null
      }

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

  // Quando o servidor desconecta o usuário (ficou sozinho 5min+), sai da sala.
  useEffect(() => {
    if (kickNotice && inCallRef.current) {
      leaveChannel()
    }
  }, [kickNotice, leaveChannel])

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
    // Não desmuta o microfone se ele já estava mudo.
    void reacquire(next, !micOn)
  }, [camOn, micOn, reacquire])

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
      const videoConstraints = quality === 'auto' ? true : QUALITY_CONSTRAINTS[quality]
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: screenWithAudio,
      })
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
  }, [applyQualityToStreams, quality, broadcastScreenKind, screenWithAudio])

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

  const clearChatChannel = useCallback(async (channelId: ChannelId) => {
    const res = await apiClient.post<{ cleared: number }>('/api/rtc', {
      action: 'chat-clear',
      channel: channelId,
    })
    if (res.success) {
      if (channelId === channelRef.current) {
        seenChatRef.current = new Set()
        setChat([])
      }
      toast.success(t('chatClearedOk'))
    } else {
      toast.error('Não foi possível apagar as conversas')
    }
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
  // Envia o perfil para a conta quando o usuário está logado.
  const persistProfileToServer = useCallback((next: Profile) => {
    if (!authUserRef.current) return
    void fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: next.name, bio: next.bio, photo: next.photo, cover: next.cover }),
    }).catch(() => {})
  }, [])

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    try {
      localStorage.removeItem('orbit_authed_device') // sai: não força retorno ao login
    } catch {}
    setAuth(null)
    window.location.reload()
  }, [setAuth])

  // ---- Exclusão de conta (carência de 3 dias + cancelar) ----
  const scheduleDeleteAccount = useCallback(async () => {
    setDeleting(true)
    try {
      const res = await apiClient.post<{ deleteScheduledAt: number | null }>('/api/account', {
        action: 'schedule-delete',
      })
      if (res.success && res.data) setDeleteScheduledAt(res.data.deleteScheduledAt)
    } finally {
      setDeleting(false)
    }
  }, [])

  const cancelDeleteAccount = useCallback(async () => {
    setDeleting(true)
    try {
      const res = await apiClient.post<{ deleteScheduledAt: number | null }>('/api/account', {
        action: 'cancel-delete',
      })
      if (res.success && res.data) setDeleteScheduledAt(res.data.deleteScheduledAt)
    } finally {
      setDeleting(false)
    }
  }, [])

  const scheduleDeleteAnon = useCallback(async () => {
    setDeleting(true)
    try {
      const res = await apiClient.post<{ deleteScheduledAt: number | null }>('/api/rtc', {
        action: 'schedule-delete',
        clientId: clientIdRef.current,
      })
      if (res.success && res.data) setDeleteScheduledAt(res.data.deleteScheduledAt)
    } finally {
      setDeleting(false)
    }
  }, [])

  const cancelDeleteAnon = useCallback(async () => {
    setDeleting(true)
    try {
      const res = await apiClient.post<{ deleteScheduledAt: number | null }>('/api/rtc', {
        action: 'cancel-delete',
        clientId: clientIdRef.current,
      })
      if (res.success && res.data) setDeleteScheduledAt(res.data.deleteScheduledAt)
    } finally {
      setDeleting(false)
    }
  }, [])

  const saveProfile = useCallback(async (next: Profile) => {
    // Nome único: não deixa duas pessoas usarem o mesmo nome.
    const nextName = next.name?.trim() || ''
    if (nextName) {
      const check = await apiClient.post<{ available: boolean }>('/api/rtc', {
        action: 'check-name',
        name: nextName,
        exceptClientId: clientIdRef.current,
      })
      if (check.success && !check.data.available) {
        toast.error('Este nome já está em uso. Escolha outro.')
        return
      }
    }
    profileRef.current = next
    setProfile(next)
    localStorage.setItem(PROFILE_KEY, JSON.stringify(next))
    persistProfileToServer(next)
    setEditProfileOpen(false)
    if (next.name) nameRef.current = next.name
    registerPresence()
    if (!inCallRef.current) return
    const res = await apiClient.post<{ channel: ChannelId; members: Member[] }>(
      '/api/rtc',
      {
        action: 'join',
        clientId: clientIdRef.current,
        name: next.name,
        photo: next.photo,
        bio: next.bio,
        cover: next.cover,
        channel: channelRef.current,
      }
    )
    if (!res.success) toast.error(res.error)
  }, [persistProfileToServer, registerPresence])

  const resetMyName = useCallback(async () => {
    if (!authUserRef.current) {
      toast.error('Faça login com o Google para trocar seu nome.')
      return
    }
    const next = (window.prompt('Qual nome você quer usar?') || '').trim()
    if (!next) return
    // Nome único: não deixa duas pessoas usarem o mesmo nome.
    const check = await apiClient.post<{ available: boolean }>('/api/rtc', {
      action: 'check-name',
      name: next,
      exceptClientId: clientIdRef.current,
    })
    if (check.success && !check.data.available) {
      toast.error('Este nome já está em uso. Escolha outro.')
      return
    }
    const saved: Profile = {
      name: next,
      photo: profileRef.current.photo,
      bio: profileRef.current.bio,
      cover: profileRef.current.cover,
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(saved))
    persistProfileToServer(saved)
    nameRef.current = next
    profileRef.current = saved
    setName(next)
    setProfile(saved)
    toast.success(`Nome alterado para ${next}`)
    registerPresence()
    if (inCallRef.current && channelRef.current) {
      void apiClient.post('/api/rtc', {
        action: 'join',
        clientId: clientIdRef.current,
        name: next,
        photo: saved.photo,
        bio: saved.bio,
        cover: saved.cover,
        channel: channelRef.current,
      })
    }
  }, [persistProfileToServer, registerPresence])

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
    // Telas simuladas (somente no modo administrador).
    if (isAdmin) {
      for (const demoTile of demoScreens) {
        tiles.push({
          id: `demo-screen-${demoTile}`,
          name: `${demoTile} · simulação`,
          stream: null,
          hasVideo: false,
          isLocal: false,
          peerId: null,
          muted: false,
          isScreen: true,
          simulated: true,
        })
      }
    }
  }

  // Ordena as telas compartilhadas por ordem de ativação (quem começou primeiro).
  const allScreenTiles = tiles.filter((t) => t.isScreen)
  screenOrderRef.current = allScreenTiles
    .map((t) => t.id)
    .filter((id) => screenOrderRef.current.includes(id))
    .concat(allScreenTiles.map((t) => t.id).filter((id) => !screenOrderRef.current.includes(id)))
  const screenTiles = [...allScreenTiles].sort(
    (a, b) => screenOrderRef.current.indexOf(a.id) - screenOrderRef.current.indexOf(b.id)
  )
  const normalTiles = tiles.filter((t) => !t.isScreen)
  const primaryScreen = screenTiles[0]
  const secondaryScreen = screenTiles[1]
  const extraScreens = screenTiles.slice(2)

  const renderTile = (tile: Tile) => {
    // Placeholder para telas simuladas (modo de teste).
    if (tile.simulated) {
      return (
        <div
          key={tile.id}
          className="flex aspect-video w-[320px] max-w-[90%] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-indigo-400/40 bg-gradient-to-br from-indigo-950/60 to-slate-900/60 p-3 text-center"
        >
          <div className="text-3xl">🖥️</div>
          <span className="text-sm font-semibold text-indigo-200">{tile.name}</span>
          <span className="rounded-md bg-indigo-500/20 px-2 py-0.5 text-[10px] font-medium text-indigo-300">{t('screenSimLabel')}</span>
        </div>
      )
    }
    return (
      <div
        key={tile.id}
      onContextMenu={tile.isLocal ? undefined : (e) => e.preventDefault()}
      ref={(el) => {
        tileElsRef.current[tile.id] = el
      }}
      className={`relative overflow-hidden rounded-xl ${
        tile.hasVideo ? 'border border-white/10 bg-black/60' : 'bg-transparent'
      } ${
        tile.isScreen
          ? 'aspect-video w-[420px] max-w-full sm:w-[520px] lg:w-[720px]'
          : tile.hasVideo
            ? 'aspect-video w-[300px] max-w-[80%] sm:w-[340px] lg:w-[400px]'
            : 'aspect-square w-24 sm:w-28'
      }`}
    >
      {tile.hasVideo ? (
        <video
          autoPlay
          playsInline
          muted={tile.isLocal || tile.muted || !!screenMuted[tile.id]}
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
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1">
            <div className="relative">
              <div
                className={`flex aspect-square w-16 items-center justify-center rounded-full ring-2 transition-colors ${
                  speakers[tile.id] ? 'ring-emerald-400' : 'ring-slate-600/50'
                }`}
              >
                <div className="flex aspect-square w-16 items-center justify-center overflow-hidden rounded-full bg-white/10">
                  <Avatar name={tile.name} photo={tile.photo} size={48} />
                </div>
              </div>
              {speakers[tile.id] && (
                <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-emerald-400" />
              )}
              {(tile.isLocal ? !micOn : tile.muted) && (
                <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-500/90 text-xs text-white">🔇</span>
              )}
            </div>
            <span className="max-w-full truncate px-1 text-[11px] font-medium text-slate-100">
              {tile.name}
            </span>
            {!(tile.isLocal ? !micOn : tile.muted) && (
              <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> ao vivo
              </span>
            )}
          </div>
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
          {tile.isScreen && !tile.isLocal && (
            <button
              title={screenMuted[tile.id] ? t('screenUnmute') : t('screenMute')}
              onClick={() => setScreenMuted((prev) => ({ ...prev, [tile.id]: !(prev[tile.id] ?? false) }))}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm backdrop-blur transition ${
                screenMuted[tile.id]
                  ? 'bg-red-500/80 hover:bg-red-500'
                  : 'bg-black/50 hover:bg-black/70'
              }`}
            >
              {screenMuted[tile.id] ? '🔇' : '🔊'}
            </button>
          )}
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
  }

  // Conecta um analisador para cada trilha de áudio ativa dos participantes.
  useEffect(() => {
    const seen = new Set<string>()
    const ctx = ensureAudioCtx()
    tiles.forEach((tile) => {
      if (!tile.stream || tile.stream.getAudioTracks().length === 0) return
      seen.add(tile.stream.id)
      if (analysersRef.current.has(tile.stream.id) || !ctx) return
      try {
        const source = ctx.createMediaStreamSource(tile.stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.3
        source.connect(analyser)
        analysersRef.current.set(tile.stream.id, analyser)
      } catch {
        /* noop */
      }
    })
    for (const id of analysersRef.current.keys()) {
      if (!seen.has(id)) {
        analysersRef.current.get(id)?.disconnect()
        analysersRef.current.delete(id)
      }
    }
  }, [tiles, ensureAudioCtx])

  // Verifica periodicamente o nível de áudio para acender o anel verde.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = { ...speakersRef.current }
      let changed = false
      tiles.forEach((tile) => {
        const muted = tile.isLocal ? !micOn : tile.muted
        if (muted || !tile.stream) {
          if (next[tile.id]) {
            delete next[tile.id]
            changed = true
          }
          return
        }
        const analyser = analysersRef.current.get(tile.stream.id)
        if (!analyser) return
        const buf = new Uint8Array(analyser.fftSize)
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        const speaking = rms > 0.015
        if (!!next[tile.id] !== speaking) {
          next[tile.id] = speaking
          changed = true
        }
      })
      if (changed) {
        speakersRef.current = next
        setSpeakers(next)
      }
    }, 140)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, micOn, mutedPeers])

  const renderMain = () => {
    if (!inCall) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="text-5xl">🎧</div>
          <h2 className="mt-4 text-xl font-bold">{t('chooseChannel')}</h2>
          <p className="mt-2 max-w-md text-sm text-slate-400">{t('chooseHintFull')}</p>
          <button
            onClick={() => setMobileTab('inicio')}
            className="mt-4 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 lg:hidden"
          >
            {t('seeRooms')}
          </button>
        </div>
      )
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto py-2">
        {/* Modo de teste com telas simuladas (somente admin) */}
        {isAdmin && demoScreens.length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">
            <span>{t('demoBanner')} ({demoScreens.length})</span>
            <div className="flex gap-2">
              <button
                onClick={() => setDemoScreens((d) => [...d, `Usuário ${d.length + 3}`])}
                className="rounded-md bg-indigo-500/20 px-2 py-1 font-semibold hover:bg-indigo-500/30"
              >
                + {t('addDemoScreen')}
              </button>
              <button
                onClick={() => setDemoScreens([])}
                className="rounded-md bg-white/10 px-2 py-1 font-semibold hover:bg-white/20"
              >
                {t('clearDemo')}
              </button>
            </div>
          </div>
        )}
        {/* 1ª tela compartilhada: fica no topo */}
        {primaryScreen && <div className="flex items-center justify-center">{renderTile(primaryScreen)}</div>}
        {/* 2ª tela: fica no meio + botão "ver mais" a partir da 3ª */}
        {secondaryScreen && (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {renderTile(secondaryScreen)}
            {extraScreens.length > 0 && (
              <button
                onClick={() => setShowMoreScreens(true)}
                className="flex h-24 w-44 flex-col items-center justify-center gap-1.5 rounded-2xl border border-indigo-400/30 bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/10 text-indigo-100 shadow-lg shadow-indigo-500/10 transition hover:scale-[1.03] hover:from-indigo-500/30 hover:to-fuchsia-500/20"
              >
                <span className="text-2xl">🎬</span>
                <span className="text-[12px] font-bold">{t('seeMoreScreens')}</span>
                <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-200">
                  {extraScreens.length} {t('screenShort')}
                </span>
              </button>
            )}
          </div>
        )}
        {/* participantes / avatares */}
        {normalTiles.length > 0 && (
          <div className="flex min-h-0 flex-wrap content-start items-start justify-start gap-3">
            {normalTiles.map((tile) => renderTile(tile))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`theme-${settings.theme} relative flex h-dvh flex-col gap-3 overflow-hidden p-3 pb-24 lg:h-screen lg:grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:grid-rows-[minmax(0,auto)_minmax(0,1fr)] lg:overflow-hidden lg:pb-3`}
      onClick={() => {
        setProfileMenuMsg(null)
      }}
    >
      <Toaster position="top-center" theme="dark" />

      {/* Sidebar */}
      <aside
        className={`share-panel flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl p-3 lg:col-start-1 lg:row-start-1 ${
          !inCall ? 'lg:row-span-2' : ''
        } ${mobileTab === 'inicio' ? 'flex' : 'hidden'} lg:flex`}
      >
        <div className="flex flex-col items-center px-1 pt-1 text-center">
          <img
            src="/logo.png"
            alt="Orbit Room"
            className="h-20 w-20 flex-none object-contain drop-shadow-2xl"
          />
          <h1 className="font-brand mt-2.5 bg-gradient-to-r from-indigo-400 via-fuchsia-400 to-indigo-400 bg-clip-text text-3xl font-bold uppercase tracking-[0.1em] text-transparent">
            Orbit Room
          </h1>
          <span className="mt-1.5 rounded-full bg-emerald-500/15 px-3 py-0.5 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-400/20">{t('voice')}</span>
        </div>

        {/* Mini perfil compacto + botão editar */}
        <div className="share-panel-soft mt-4 flex items-center gap-2 rounded-lg px-2 py-1.5">
          <Avatar name={profile.name || name} photo={profile.photo} size={30} isAnonymous={!authUserRef.current} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {profile.name || name}
          </span>
          <button
            type="button"
            title="Quem está online e offline"
            onClick={() => {
              setConfigPane('online')
              setConfigOpen(true)
              setMobileTab('config')
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs transition hover:bg-white/20"
          >
            👥
          </button>
          <div
            role="button"
            tabIndex={0}
            title={t('configTitle')}
            onClick={() => {
              setConfigPane('menu')
              setConfigOpen(true)
              setMobileTab('config')
            }}
            className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs transition lg:flex ${
              configOpen ? 'bg-white/20' : 'hover:bg-white/20'
            }`}
          >
            ⚙️
          </div>
          {!authUser && (
            <a
              href="/login"
              title="Entrar para salvar seu perfil"
              className="flex h-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-r from-indigo-500/40 to-fuchsia-500/40 px-2 text-[11px] font-semibold text-indigo-100 ring-1 ring-indigo-400/30 transition hover:from-indigo-500/60 hover:to-fuchsia-500/60"
            >
              Entrar
            </a>
          )}
        </div>

        {/* Início: grade de categorias */}
        {inicioView === 'home' ? (
          <div className="mt-4 grid flex-1 grid-cols-2 grid-rows-2 gap-3">
            <button
              onClick={() => setInicioView('publicas')}
              className="group flex flex-col items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-indigo-500/30 to-fuchsia-500/15 ring-1 ring-indigo-400/20 transition hover:scale-[1.03] hover:from-indigo-500/40 hover:to-fuchsia-500/25"
            >
              <span className="text-4xl drop-shadow">🌐</span>
              <span className="px-2 text-center text-sm font-bold leading-tight">{t('publicRooms')}</span>
              <span className="px-3 text-center text-[10px] text-indigo-200/70">{t('publicRoomsDesc')}</span>
            </button>
            <button
              onClick={() => setInicioView('privadas')}
              className="group flex flex-col items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-amber-500/25 to-orange-500/10 ring-1 ring-amber-400/20 transition hover:scale-[1.03] hover:from-amber-500/35 hover:to-orange-500/20"
            >
              <span className="text-4xl drop-shadow">🔒</span>
              <span className="px-2 text-center text-sm font-bold leading-tight">{t('privateRooms')}</span>
              <span className="px-3 text-center text-[10px] text-amber-200/70">{t('privateRoomsDesc')}</span>
            </button>
            <button
              onClick={() => setInicioView('criar')}
              className="group flex flex-col items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-emerald-500/25 to-teal-500/10 ring-1 ring-emerald-400/20 transition hover:scale-[1.03] hover:from-emerald-500/35 hover:to-teal-500/20"
            >
              <span className="text-4xl drop-shadow">➕</span>
              <span className="px-2 text-center text-sm font-bold leading-tight">{t('createRoom')}</span>
              <span className="px-3 text-center text-[10px] text-emerald-200/70">{t('createRoomDesc')}</span>
            </button>
            <button
              onClick={() => setInicioView('minhas')}
              className="group flex flex-col items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-sky-500/25 to-cyan-500/10 ring-1 ring-sky-400/20 transition hover:scale-[1.03] hover:from-sky-500/35 hover:to-cyan-500/20"
            >
              <span className="text-4xl drop-shadow">📁</span>
              <span className="px-2 text-center text-sm font-bold leading-tight">{t('myRooms')}</span>
              <span className="px-3 text-center text-[10px] text-sky-200/70">{t('myRoomsDesc')}</span>
            </button>
          </div>
        ) : (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setInicioView('home')}
                className="flex h-8 items-center gap-1 rounded-lg bg-white/10 px-2.5 text-xs font-semibold text-slate-200 transition hover:bg-white/15"
              >
                ← {t('back')}
              </button>
              <h3 className="text-sm font-bold">
                {({
                  publicas: t('publicRooms'),
                  privadas: t('privateRooms'),
                  criar: t('createRoom'),
                  minhas: t('myRooms'),
                } as Record<string, string>)[inicioView]}
              </h3>
            </div>
            {inicioView === 'publicas' ? (
              <div className="mt-3 flex min-h-0 flex-1 flex-col">
                <p className="mb-2 text-center text-xs font-medium text-slate-400">{t('subtitle')}</p>
                <div className="space-y-1.5 overflow-y-auto">
                {DEFAULT_CHANNELS.map((c) => {
                  const active = inCall && channel === c.id
                  const count = Math.min(
                    onlineMembers.filter((m) => m.channel === c.id).length,
                    10
                  )
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
                      <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-300">
                        {count}/10
                      </span>
                    </button>
                  )
                })}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <span className="text-4xl">🚧</span>
                <p className="mt-3 text-sm text-slate-400">{t('comingSoon')}</p>
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Palco de vídeo */}
      <main
        className={`share-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl p-3 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 ${
          mobileTab === 'chamadas' ? 'flex' : 'hidden'
        } lg:flex`}
      >
        {renderMain()}

        {/* Barra de controle (só quando estiver numa sala de voz) */}
        {inCall && (
          <>
            <div className="mt-3 flex flex-col items-center gap-2">
              {/* Fileira principal: ações essenciais em círculos */}
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={toggleMic}
                  className="flex w-20 flex-none flex-col items-center gap-1.5"
                  aria-label={micOn ? t('micOn') : t('muted')}
                >
                  <span
                    className={`flex h-12 w-12 items-center justify-center rounded-full text-lg transition ${
                      micOn
                        ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/40'
                        : 'bg-red-500 text-white shadow-lg shadow-red-500/30'
                    }`}
                  >
                    {micOn ? '🎙️' : '🔇'}
                  </span>
                  <span className="w-full text-center text-[10px] font-medium leading-tight text-slate-400">{micOn ? t('micOn') : t('muted')}</span>
                </button>

                <button
                  onClick={toggleCam}
                  className="flex w-20 flex-none flex-col items-center gap-1.5"
                  aria-label={camOn ? t('camOn') : t('camTurn')}
                >
                  <span
                    className={`flex h-12 w-12 items-center justify-center rounded-full text-lg transition ${
                      camOn
                        ? 'bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/40'
                        : 'bg-white/10 text-white hover:bg-white/15'
                    }`}
                  >
                    📷
                  </span>
                  <span className="w-full text-center text-[10px] font-medium leading-tight text-slate-400">{camOn ? t('camOn') : t('camTurn')}</span>
                </button>

                <button
                  onClick={() => void toggleScreen()}
                  className="flex w-20 flex-none flex-col items-center gap-1.5"
                  aria-label={screenStreaming ? t('screenStop') : t('screenShare')}
                >
                  <span
                    className={`flex h-12 w-12 items-center justify-center rounded-full text-lg transition ${
                      screenStreaming
                        ? 'bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-400/40'
                        : 'bg-white/10 text-white hover:bg-white/15'
                    }`}
                  >
                    🖥️
                  </span>
                  <span className="w-full text-center text-[10px] font-medium leading-tight text-slate-400">{screenStreaming ? t('screenStop') : t('screenShare')}</span>
                </button>
              </div>

              {/* Fileira secundária: áudio na tela + qualidade */}
              <div className="flex items-center justify-center gap-2">
                {isAdmin && (
                  <button
                    onClick={() => setDemoScreens((d) => (d.length === 0 ? ['Usuário 3'] : d))}
                    title={t('addDemoScreen')}
                    className="flex h-8 min-w-28 items-center justify-center gap-1 rounded-full bg-indigo-500/15 px-3 text-[11px] font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/25"
                  >
                    🧪 {t('addDemoScreen')}
                  </button>
                )}
                <button
                  onClick={() => setScreenWithAudio((o) => !o)}
                  disabled={screenStreaming}
                  title={t('screenAudio')}
                  className={`flex h-8 min-w-28 items-center justify-center gap-1 rounded-full px-3 text-[11px] font-semibold transition disabled:opacity-40 ${
                    screenWithAudio
                      ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/30'
                      : 'bg-white/10 text-slate-300 hover:bg-white/15'
                  }`}
                >
                  {screenWithAudio ? `🔊 ${t('screenAudio')}` : `🔇 ${t('screenNoAudio')}`}
                </button>
                <label className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[11px] font-medium text-slate-300">
                  {t('currentQuality')}
                  <select
                    value={quality}
                    onChange={(e) => setQualityAndApply(e.target.value as Quality)}
                    className="bg-transparent text-[11px] font-semibold text-white outline-none"
                  >
                    {QUALITY_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                onClick={leaveChannel}
                className="mt-1 flex w-full max-w-xs items-center justify-center gap-1.5 rounded-xl bg-red-500/90 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-red-500/20 transition hover:bg-red-500"
              >
                📵 {t('leaveChannel')}
              </button>
            </div>
          </>
        )}
      </main>

      {/* Chat do canal */}
      <aside
        className={`share-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl p-4 lg:col-start-1 lg:row-start-2 lg:min-h-0 ${
          mobileTab === 'chat' ? 'flex' : 'hidden'
        } ${inCall ? 'lg:flex' : 'lg:hidden'}`}
      >
        {!inCall ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <div className="text-5xl">💬</div>
            <h2 className="mt-4 text-xl font-bold">{t('chatTitle')}</h2>
            <p className="mt-2 max-w-md text-sm text-slate-400">{t('locked')}</p>
          </div>
        ) : (
          <>
            <h3 className="text-sm font-semibold">{t('chatTitle')} · {channelLabel(channel)}</h3>
            <div className="relative mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {chat.map((m) => (
                <div key={m.id} className="share-panel-soft group relative rounded-lg px-3 py-2">
                  {m.cover ? (
                    <div className="-mx-3 -mt-2 mb-2 h-2 rounded-t-lg bg-cover bg-center" style={{ backgroundImage: `url(${m.cover})` }} />
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[11px] text-slate-400">
                      <strong className="text-indigo-300">{m.author}</strong> · {new Date(m.time).toLocaleTimeString()}
                    </p>
                    <button
                      title="Opções da mensagem"
                      onClick={(e) => {
                        e.stopPropagation()
                        const open = profileMenuMsg === m.id
                        setProfileMenuMsg(open ? null : m.id)
                        setMsgRelation(null)
                        if (!open && !m.isAnonymous && m.userId && authUser && m.userId !== authUser.id) {
                          fetch('/api/social/user?userId=' + encodeURIComponent(m.userId))
                            .then((r) => r.json())
                            .then((d) => {
                              if (d?.relation) {
                                setMsgRelation({
                                  isFriend: !!d.relation.isFriend,
                                  isFollowing: !!d.relation.isFollowing,
                                  requestStatus: d?.requestStatus || null,
                                })
                              }
                            })
                            .catch(() => {})
                        }
                      }}
                      className="shrink-0 text-slate-500 transition hover:text-slate-200"
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
                          if (m.isAnonymous) {
                            setViewAnonProfile({ name: m.author })
                          } else {
                            setViewProfile({ name: m.author, photo: m.photo, bio: m.bio, cover: m.cover, userId: m.userId })
                          }
                          setProfileMenuMsg(null)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5"
                      >
                        👤 Ver perfil
                      </button>
                      {!m.isAnonymous && m.userId && authUser && m.userId !== authUser.id && (
                        <>
                          {msgRelation?.isFriend ? (
                            <div className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-400">
                              ✅ Amigos
                            </div>
                          ) : msgRelation?.requestStatus ? (
                            <div className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-400">
                              ⏳ Pendente
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                void fetch('/api/social', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ action: 'send-request', toUserId: m.userId }),
                                })
                                  .then((r) => r.json())
                                  .then((res) =>
                                    toast(res?.ok ? res.message || 'Convite enviado!' : res?.message || 'Não foi possível adicionar')
                                  )
                                setProfileMenuMsg(null)
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-emerald-300 hover:bg-white/5"
                            >
                              🤝 Adicionar amigo
                            </button>
                          )}
                          {!msgRelation?.isFollowing && (
                            <button
                              onClick={() => {
                                void fetch('/api/social', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ action: 'follow', userId: m.userId }),
                                })
                                  .then((r) => r.json())
                                  .then((res) => toast(res?.ok ? 'Você agora segue esta pessoa.' : res?.message || 'Não foi possível seguir'))
                                setProfileMenuMsg(null)
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-indigo-200 hover:bg-white/5"
                            >
                              ➕ Seguir
                            </button>
                          )}
                        </>
                      )}
                      <button
                        onClick={() => {
                          setPendingDeleteMe(m.id)
                          setProfileMenuMsg(null)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/5"
                      >
                        🙈 Apagar para mim
                      </button>
                      {(isAdmin || m.memberId === clientId) && (
                        <button
                          onClick={() => {
                            deleteChat(m.id)
                            setProfileMenuMsg(null)
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-red-400 hover:bg-white/5"
                        >
                          🗑️ Apagar para todos
                        </button>
                      )}
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
                placeholder={t('writeMsg')}
                className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-800/60 px-3 text-sm outline-none focus:border-indigo-400/50"
              />
              <button
                type="submit"
                className="h-10 rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white transition hover:bg-indigo-400"
              >
                {t('send')}
              </button>
            </form>
          </>
        )}
      </aside>

      {/* Modais */}
      <ProfileEditModal
        open={editProfileOpen}
        profile={profile}
        authed={!!authUser}
        onClose={() => setEditProfileOpen(false)}
        onSave={(next) => {
          void saveProfile(next)
        }}
      />
      {viewProfile && (
        <ProfileViewModal
          profile={viewProfile}
          currentUserId={authUser?.id}
          onClose={() => setViewProfile(null)}
          onNavigate={(p) => setViewProfile({ userId: p.userId, name: p.name, photo: p.photo ?? undefined })}
        />
      )}
      {viewAnonProfile && (
        <AnonProfileModal name={viewAnonProfile.name} onClose={() => setViewAnonProfile(null)} />
      )}

      {/* Barra inferior de categorias (só mobile) */}
      <nav className="share-panel fixed inset-x-3 bottom-3 z-50 flex items-center gap-1 rounded-2xl p-2 shadow-2xl lg:hidden">
        <button
          onClick={() => {
            setConfigOpen(false)
            setMobileTab('inicio')
          }}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'inicio' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">🧭</span>
          {t('homeTab')}
        </button>
        <button
          onClick={() => {
            setConfigOpen(false)
            setMobileTab('chamadas')
          }}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'chamadas' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">{inCall ? '🔊' : '🎧'}</span>
          {t('callTab')}
        </button>
        <button
          onClick={() => {
            setConfigOpen(false)
            setMobileTab('chat')
          }}
          className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'chat' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">💬</span>
          {t('chatTab')}
        </button>
        <button
          onClick={() => {
            setConfigPane('menu')
            setConfigOpen(true)
            setMobileTab('config')
          }}
          className={`flex w-16 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
            mobileTab === 'config' ? 'bg-indigo-500/25 text-indigo-200' : 'text-slate-400 hover:bg-white/5'
          }`}
        >
          <span className="text-lg leading-none">⚙️</span>
          {t('configTab')}
        </button>
      </nav>

      {/* Painel de Configurações no mobile (perfil + avançadas) */}
      {(mobileTab === 'config' || configOpen) && (
        <div className="share-panel share-panel-flat fixed inset-0 z-40 flex flex-col overflow-hidden lg:inset-y-6 lg:left-1/2 lg:h-[88vh] lg:w-full lg:max-w-5xl lg:-translate-x-1/2 lg:flex-row lg:rounded-2xl lg:p-0">
          <div className="flex items-center justify-between gap-2 p-4 lg:hidden">
            <div className="flex items-center gap-2">
              {configPane !== 'menu' && (
                <button
                  onClick={() => setConfigPane('menu')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-slate-300 transition hover:bg-white/15"
                  aria-label={t('back')}
                >
                  ←
                </button>
              )}
              <h3 className="text-base font-bold">
                {({ menu: t('configTitle'), conta: t('account'), perfil: t('profile'), avancado: t('advanced'), audio: t('audioVideo'), aparencia: t('appearance'), notificacoes: t('notifications'), silencioso: t('silentMode'), idioma: t('language'), limpeza: t('cleanup'), sobre: t('about'), online: t('onlinePeople'), amigos: t('amigos') } as Record<string, string>)[configPane]}
              </h3>
            </div>
            {configPane !== 'menu' && (
              <button
                onClick={() => {
                  setConfigOpen(false)
                  setMobileTab('inicio')
                }}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/15"
              >
                {t('close')}
              </button>
            )}
          </div>

          {/* Menu lateral — mobile (lista quando acessa o menu) */}
          <div
            className={`flex flex-col gap-3 overflow-y-auto no-scrollbar p-4 pb-28 lg:hidden ${
              configPane === 'menu' ? '' : 'hidden'
            }`}
          >
            {(
              [
                ['conta', '🔑', 'bg-indigo-500/20', t('account'), t('accountDesc')],
                ['perfil', '👤', 'bg-indigo-500/20', t('profile'), t('perfilDesc')],
                ['amigos', '🤝', 'bg-emerald-500/15', t('amigos'), t('amigosDesc')],
                ['online', '👥', 'bg-emerald-500/15', t('onlinePeople'), t('onlinePeopleDesc')],
                ['audio', '🎙️', 'bg-sky-500/15', t('audioVideo'), t('audioDesc')],
                ['aparencia', '🎨', 'bg-fuchsia-500/15', t('appearance'), t('aparenciaDesc')],
                ['notificacoes', '🔔', 'bg-amber-500/15', t('notifications'), t('notificacoesDesc')],
                ['silencioso', '🤫', 'bg-slate-500/15', t('silentMode'), t('silenciosoDesc')],
                ['idioma', '🌐', 'bg-emerald-500/15', t('language'), t('idiomaDesc')],
                ['limpeza', '🧹', 'bg-red-500/15', t('cleanup'), t('limpezaDesc')],
                ['sobre', 'ℹ️', 'bg-cyan-500/15', t('about'), t('sobreDesc')],
                ['avancado', '🛠️', 'bg-emerald-500/15', t('advanced'), t('avancadoDesc')],
              ] as const
            ).map(([id, icon, bg, label, desc]) => (
              <button
                key={id}
                onClick={() => setConfigPane(id)}
                className="share-panel-soft relative flex items-center gap-3 rounded-xl p-4 text-left transition-colors duration-100 hover:bg-white/5"
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
                {id === 'amigos' && pendingCount > 0 && (
                  <span className="absolute right-3 top-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white shadow-lg shadow-rose-500/40">
                    {pendingCount > 9 ? '+9' : pendingCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Menu lateral — desktop (sempre visível) */}
          <div className="hidden flex-col gap-1 overflow-y-auto no-scrollbar p-3 lg:flex lg:w-72 lg:shrink-0 lg:border-r lg:border-white/10">
            <div className="mb-1 px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              ⚙️ {t('configTitle')}
            </div>
            {(
              [
                ['conta', '🔑', t('account')],
                ['perfil', '👤', t('profile')],
                ['amigos', '🤝', t('amigos')],
                ['online', '👥', t('onlinePeople')],
                ['audio', '🎙️', t('audioVideo')],
                ['aparencia', '🎨', t('appearance')],
                ['notificacoes', '🔔', t('notifications')],
                ['silencioso', '🤫', t('silentMode')],
                ['idioma', '🌐', t('language')],
                ['limpeza', '🧹', t('cleanup')],
                ['sobre', 'ℹ️', t('about')],
                ['avancado', '🛠️', t('advanced')],
              ] as const
            ).map(([id, icon, label]) => (
              <button
                key={id}
                onClick={() => setConfigPane(id)}
                className={`relative flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm font-semibold transition-colors duration-100 ${
                  configPane === id
                    ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/30'
                    : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <span className="w-6 text-center text-base leading-none">{icon}</span>
                {label}
                {id === 'amigos' && pendingCount > 0 && (
                  <span className="absolute right-2 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white shadow-lg shadow-rose-500/40">
                    {pendingCount > 9 ? '+9' : pendingCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Conteúdo da categoria selecionada */}
          <div
            className={`min-h-0 flex-1 flex-col overflow-hidden ${
              configPane === 'menu' ? 'hidden lg:flex' : 'mt-4 flex lg:mt-0'
            }`}
          >
            {/* Cabeçalho desktop */}
            <div className="hidden items-center justify-between border-b border-white/10 px-5 py-3 lg:flex">
              <h3 className="text-base font-bold">
                {({ conta: t('account'), perfil: t('profile'), avancado: t('advanced'), audio: t('audioVideo'), aparencia: t('appearance'), notificacoes: t('notifications'), silencioso: t('silentMode'), idioma: t('language'), limpeza: t('cleanup'), sobre: t('about'), online: t('onlinePeople'), amigos: t('amigos'), menu: t('configTitle') } as Record<string, string>)[configPane]}
              </h3>
              <button
                onClick={() => {
                  setConfigOpen(false)
                  setMobileTab('inicio')
                }}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/15"
              >
                ✕ {t('close')}
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto no-scrollbar pb-28 lg:p-5">
              {configPane === 'menu' && (
                <div className="hidden flex-1 items-center justify-center rounded-xl share-panel-soft p-6 text-center lg:flex">
                  <div>
                    <div className="text-3xl">⚙️</div>
                    <p className="mt-2 text-sm text-slate-400">
                      {settings.language === 'en' ? 'Choose a category on the left' : 'Escolha uma categoria à esquerda'}
                    </p>
                  </div>
                </div>
              )}
              {/* Perfil */}
              {configPane === 'perfil' && (
                <section className="share-panel-soft flex flex-col gap-3 rounded-xl p-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/20 text-xl">
                      👤
                    </span>
                    <div>
                    <div className="text-sm font-semibold">{profile.name || t('noName')}</div>
                    <div className="text-xs text-slate-400">{t('publicProfile')}</div>
                    </div>
                  </div>
                  {!authUser && (
                    <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
                      Faça login com o Google para alterar seu nome, foto e bio.
                    </div>
                  )}
                  <button
                    onClick={() => {
                      setEditProfileOpen(true)
                      setMobileTab('inicio')
                    }}
                    className="w-full rounded-xl bg-indigo-500/20 px-4 py-3 text-left text-sm font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/30"
                  >
                    ✏️ {t('editProfile')}
                  </button>
                  <button
                    onClick={() => resetMyName()}
                    className="w-full rounded-xl bg-emerald-500/20 px-4 py-3 text-left text-sm font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
                  >
                    ✏️ {t('changeName')}
                  </button>
                </section>
              )}

              {/* Minha conta (login com Google) */}
              {configPane === 'conta' && (
                <section className="share-panel-soft flex flex-col gap-3 rounded-xl p-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/20 text-xl">
                      🔑
                    </span>
                    <div>
                      <div className="text-sm font-semibold">{t('account')}</div>
                      <div className="text-xs text-slate-400">{t('accountInfo')}</div>
                    </div>
                  </div>

                  {authUser ? (
                    <>
                      {/* Capa com avatar redondo sobreposto no canto inferior esquerdo */}
                      <div className="relative">
                        <div
                          className="h-28 w-full rounded-xl bg-cover bg-center ring-1 ring-white/10"
                          style={
                            profile.cover
                              ? { backgroundImage: `url(${profile.cover})` }
                              : undefined
                          }
                        >
                          {!profile.cover && (
                            <div className="flex h-full w-full items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/25 to-fuchsia-500/10 text-3xl">
                              🖼️
                            </div>
                          )}
                        </div>
                        <div className="absolute -bottom-6 left-3">
                          <Avatar
                            name={profile.name || name}
                            photo={profile.photo}
                            size={64}
                            className="ring-4 ring-slate-900"
                            isAnonymous={false}
                          />
                        </div>
                      </div>

                      {/* Nome e e-mail dentro da caixa */}
                      <div className="mt-7 flex flex-col gap-1.5 px-1">
                        <div className="truncate text-base font-bold">{profile.name || name}</div>
                        <div className="flex items-center gap-2">
                          <span
                            translate="no"
                            className="truncate rounded-md bg-white/5 px-2 py-1 text-xs text-slate-300 ring-1 ring-white/10"
                          >
                            {revealEmail ? authUser.email : maskEmail(authUser.email)}
                          </span>
                          <button
                            type="button"
                            title={revealEmail ? t('hideEmail') : t('revealEmail')}
                            onClick={() => setRevealEmail((v) => !v)}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs transition hover:bg-white/20"
                          >
                            {revealEmail ? '🙈' : '👁️'}
                          </button>
                        </div>
                      </div>

                      <p className="mt-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-400">
                        💡 {t('accountEditHint')}
                      </p>

                      <button
                        type="button"
                        onClick={() => void handleLogout()}
                        className="mt-1 w-full rounded-xl bg-rose-500/20 px-4 py-3 text-left text-sm font-semibold text-rose-200 ring-1 ring-rose-400/30 transition hover:bg-rose-500/30"
                      >
                        ⎋ {t('signOut')}
                      </button>

                      {/* Exclusão da conta (3 dias de carência + cancelar) */}
                      {deleteScheduledAt ? (
                        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-3">
                          <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
                            ⏳ {t('deleteScheduled')}
                          </div>
                          <p className="mt-1 text-xs text-rose-100/70">{t('deleteCountdownHint')}</p>
                          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                            <DeleteCountdown until={deleteScheduledAt} />
                            <button
                              type="button"
                              onClick={() => void cancelDeleteAccount()}
                              disabled={deleting}
                              className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30 disabled:opacity-50"
                            >
                              💚 {t('cancelDelete')}
                            </button>
                          </div>
                          <p className="mt-1.5 text-[11px] text-slate-400">{t('deleteStillWorks')}</p>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void scheduleDeleteAccount()}
                          disabled={deleting}
                          className="w-full rounded-xl bg-rose-500/10 px-4 py-3 text-left text-sm font-semibold text-rose-300 ring-1 ring-rose-400/20 transition hover:bg-rose-500/20 disabled:opacity-50"
                        >
                          🗑 {t('deleteAccount')}
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center">
                      <div className="text-4xl">🔑</div>
                      <div className="text-sm font-semibold">{t('notConnected')}</div>
                      <p className="max-w-xs text-xs text-slate-400">{t('accountSignInHint')}</p>
                      <a
                        href="/login"
                        className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110"
                      >
                        <span className="text-lg leading-none">🌐</span> {t('signInGoogle')}
                      </a>
                    </div>
                  )}

                  {/* Exclusão da conta anônima (3 dias de carência + cancelar) */}
                  {!authUser && (
                    deleteScheduledAt ? (
                      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-3">
                        <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
                          ⏳ {t('deleteScheduled')}
                        </div>
                        <p className="mt-1 text-xs text-rose-100/70">{t('deleteCountdownHint')}</p>
                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                          <DeleteCountdown until={deleteScheduledAt} />
                          <button
                            type="button"
                            onClick={() => void cancelDeleteAnon()}
                            disabled={deleting}
                            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30 disabled:opacity-50"
                          >
                            💚 {t('cancelDelete')}
                          </button>
                        </div>
                        <p className="mt-1.5 text-[11px] text-slate-400">{t('deleteStillWorks')}</p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void scheduleDeleteAnon()}
                        disabled={deleting}
                        className="w-full rounded-xl bg-rose-500/10 px-4 py-3 text-left text-sm font-semibold text-rose-300 ring-1 ring-rose-400/20 transition hover:bg-rose-500/20 disabled:opacity-50"
                      >
                        🗑 {t('deleteAccountAnon')}
                      </button>
                    )
                  )}
                </section>
              )}

              {/* Quem está online/offline */}
              {configPane === 'online' && (
                <section className="share-panel-soft flex flex-col gap-3 rounded-xl p-3">
                  <div className="text-sm font-semibold">🤝 {t('friendsOnline')}</div>
                  <FriendsOnline
                    onOpenProfile={(p) =>
                      setViewProfile({ userId: p.userId, name: p.name, photo: p.photo ?? undefined, bio: p.bio ?? undefined, cover: p.cover ?? undefined })
                    }
                  />
                </section>
              )}

              {/* Amigos: convites, código e lista */}
              {configPane === 'amigos' && (
                authUser ? (
                  <section className="share-panel-soft flex flex-col gap-3 rounded-xl p-3">
                    <FriendsPanel
                      onOpenProfile={(p) =>
                        setViewProfile({ userId: p.userId, name: p.name, photo: p.photo ?? undefined, bio: p.bio ?? undefined, cover: p.cover ?? undefined })
                      }
                    />
                  </section>
                ) : (
                  <section className="share-panel-soft flex flex-col items-center gap-3 rounded-xl p-6 text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/30 to-fuchsia-500/30 text-3xl">
                      🔒
                    </div>
                    <div className="text-sm font-semibold">{t('amigosLocked')}</div>
                    <p className="max-w-xs text-xs text-slate-400">{t('amigosLockedHint')}</p>
                    <a
                      href="/login"
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110"
                    >
                      <span className="text-lg leading-none">🌐</span> {t('signInGoogle')}
                    </a>
                  </section>
                )
              )}

              {/* Áudio e vídeo */}
              {configPane === 'audio' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🎙️ {t('audioVideo')}</h4>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-400">{t('volume')}</span>
                  <span className="text-xs tabular-nums text-slate-300">{Math.round(settings.volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.volume * 100)}
                  onChange={(e) => setSetting('volume', Number(e.target.value) / 100)}
                  className="w-full accent-indigo-400"
                  aria-label={t('volume')}
                />
                {(
                  [
                    ['noiseSuppression', t('noiseLabel')],
                    ['echoCancellation', t('echoLabel')],
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
              </section>
              )}

              {/* Aparência */}
              {configPane === 'aparencia' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🎨 {t('appearance')}</h4>
                <SwitchRow
                  checked={settings.theme === 'light'}
                  onChecked={(v) => setSetting('theme', v ? 'light' : 'dark')}
                  title={settings.theme === 'light' ? t('lightTheme') : t('darkTheme')}
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
                  title={t('notifications')}
                  desc={t('notifyDesc')}
                />
              </section>
              )}

              {/* Modo silencioso */}
              {configPane === 'silencioso' && (
              <section className="share-panel-soft rounded-xl p-3">
                <SwitchRow
                  checked={settings.silentMode}
                  onChecked={(v) => setSetting('silentMode', v)}
                  title={t('silentMode')}
                  desc={t('silentDesc')}
                />
              </section>
              )}

              {/* Idioma */}
              {configPane === 'idioma' && (
              <section className="share-panel-soft rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">🌐 {t('language')}</h4>
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
                <h4 className="mb-2 text-sm font-bold">🧹 {t('cleanup')}</h4>
                <button
                  onClick={() => void removeAllOffline()}
                  disabled={offlineMembers.length === 0}
                  className="w-full rounded-lg bg-red-500/15 px-3 py-2 text-left text-sm font-semibold text-red-300 ring-1 ring-red-400/30 transition enabled:hover:bg-red-500/25 disabled:opacity-40 disabled:ring-transparent"
                >
                  🗑 {t('deleteOffline')} ({offlineMembers.length})
                </button>
                {isAdmin && (
                  <button
                    onClick={() => setShowClearChats(true)}
                    className="mt-2 w-full rounded-lg bg-indigo-500/15 px-3 py-2 text-left text-sm font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/25"
                  >
                    💬 {t('clearAllChats')}
                  </button>
                )}
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
                  ↩️ {t('restorePrefs')}
                </button>
              </section>
              )}

              {/* Sobre */}
              {configPane === 'sobre' && (
              <section className="share-panel-soft rounded-xl p-3">
                <div className="mb-2 flex items-center gap-2">
                  <img src="/logo.png" alt="Orbit Room" className="h-7 w-7 object-contain drop-shadow" />
                  <h4 className="text-sm font-extrabold tracking-tight">Orbit Room</h4>
                  <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-200">v0.5</span>
                </div>
                {t('aboutText')
                  .split('\n\n')
                  .map((p) => (
                    <p key={p.slice(0, 20)} className="text-sm leading-relaxed text-slate-300">
                      {p}
                    </p>
                  ))}
                <p className="mt-3 border-t border-white/10 pt-2 text-[11px] font-medium text-slate-400">
                  {t('aboutCredits')}
                </p>
              </section>
              )}

              {/* Admin */}
              {configPane === 'avancado' && (
              <>
              <div className="share-panel-soft flex items-center justify-between gap-2 rounded-xl p-3">
                <span className="text-sm font-medium">{t('admin')}</span>
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
                      placeholder={t('password')}
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
                ✏️ {t('changeName')}
              </button>
              {offlineMembers.length > 0 && (
                <button
                  onClick={() => void removeAllOffline()}
                  className="w-full rounded-xl bg-red-500/15 px-4 py-3 text-left text-sm font-semibold text-red-300 ring-1 ring-red-400/30 transition hover:bg-red-500/25"
                >
                  🗑 {t('deleteAllOffline')} ({offlineMembers.length})
                </button>
              )}
              </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Janela "ver mais" com a lista de quem está compartilhando tela */}
      {showMoreScreens && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
          <div className="share-panel w-full max-w-sm rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-lg font-bold">🖥️ {t('whoIsSharing')}</div>
              <button
                onClick={() => setShowMoreScreens(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm text-slate-200 transition hover:bg-white/15"
                aria-label={t('close')}
              >
                ✕
              </button>
            </div>
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto no-scrollbar">
              {extraScreens.map((tile) => (
                <div key={tile.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2">
                  <Avatar name={tile.name} photo={tile.photo} size={30} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">{tile.name}</span>
                  <span className="flex flex-none items-center gap-1 text-[11px] text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> 🖥️ {t('screenShort')}
                  </span>
                  <button
                    onClick={() => {
                      setShowMoreScreens(false)
                      setWatchScreen(tile)
                    }}
                    className="flex-none rounded-lg bg-indigo-500/20 px-3 py-1.5 text-[11px] font-bold text-indigo-100 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/30"
                  >
                    ▶ {t('watchScreen')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tela cheia ao apertar "Assistir" no popup de mais telas */}
      {watchScreen && (
        <div className="fixed inset-0 z-[110] flex flex-col bg-black">
          <div className="flex items-center justify-between gap-2 bg-black/80 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-white">
              <span className="h-2 w-2 flex-none rounded-full bg-emerald-400" />
              <span className="truncate">{watchScreen.name}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => toggleTileFullscreen(watchScreen.id)}
                title="Tela cheia (todo o computador / celular)"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sm text-white transition hover:bg-white/20"
              >
                ⛶
              </button>
              <button
                onClick={() => setWatchScreen(null)}
                title={t('closeWatch')}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sm text-white transition hover:bg-red-500"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 p-2">
            <div ref={(el) => { tileElsRef.current[watchScreen.id] = el }} className="h-full w-full">
              {watchScreen.hasVideo ? (
                <video
                  autoPlay
                  playsInline
                  muted={!!screenMuted[watchScreen.id]}
                  className="h-full w-full object-contain"
                  ref={(el) => bind(el, watchScreen.stream)}
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
                  <div className="text-6xl">🖥️</div>
                  <span className="text-lg font-semibold text-indigo-200">{watchScreen.name}</span>
                  <span className="rounded-md bg-indigo-500/20 px-3 py-1 text-xs font-medium text-indigo-300">{t('screenSimLabel')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Aviso de desconexão por ficar sozinho no canal (AFK) */}
      {kickNotice && (
        <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/60 p-4">
          <div className="share-panel w-full max-w-sm rounded-2xl p-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500/20 text-2xl">💤</div>
            <h3 className="text-lg font-bold">{t('soloKickedTitle')}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{t('soloKicked')}</p>
            <button
              onClick={() => setKickNotice(false)}
              className="mt-5 w-full rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-400"
            >
              {t('gotIt')}
            </button>
          </div>
        </div>
      )}

      {/* Seletor de chat para limpar todas as conversas (só administrador) */}
      {showClearChats && isAdmin && (
        <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/60 p-4">
          <div className="share-panel w-full max-w-sm rounded-2xl p-5">
            <div className="mb-1 flex items-center gap-2 text-base font-bold">💬 {t('clearAllChats')}</div>
            <p className="mb-4 text-xs text-slate-400">{t('clearAllChatsDesc')}</p>
            <div className="space-y-2">
              {DEFAULT_CHANNELS.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setShowClearChats(false)
                    setPendingClearChannel(c.id)
                  }}
                  className="flex w-full items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-left transition hover:bg-white/10"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/20 text-sm font-bold text-indigo-200 ring-1 ring-indigo-400/30">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{c.label}</span>
                    <span className="block truncate text-[11px] text-slate-400">{c.description}</span>
                  </span>
                  <span className="shrink-0 text-slate-500">🗑</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowClearChats(false)}
              className="mt-4 w-full rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/15"
            >
              {t('no')}
            </button>
          </div>
        </div>
      )}

      {/* Confirmação para apagar mensagem ou limpar chat */}
      {(pendingDeleteMe || pendingClearChannel) && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4">
          <div className="share-panel w-full max-w-sm rounded-2xl p-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/20 text-2xl">🗑️</div>
            <h3 className="text-lg font-bold">
              {pendingDeleteMe ? t('confirmDeleteTitle') : t('confirmClearTitle')}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              {pendingDeleteMe ? t('confirmDeleteMsg') : t('confirmClearMsg')}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => {
                  setPendingDeleteMe(null)
                  setPendingClearChannel(null)
                }}
                className="flex-1 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/15"
              >
                {t('no')}
              </button>
              <button
                onClick={() => {
                  if (pendingDeleteMe) deleteForMe(pendingDeleteMe)
                  if (pendingClearChannel) void clearChatChannel(pendingClearChannel)
                  setPendingDeleteMe(null)
                  setPendingClearChannel(null)
                }}
                className="flex-1 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-400"
              >
                {t('yes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pedido de permissão de notificações na primeira visita */}
      {showNotifyPrompt && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-4 pb-24 sm:items-center sm:pb-4">
          <div className="share-panel w-full max-w-sm rounded-2xl p-5">
            <div className="mb-1 flex items-center gap-2 text-lg font-bold">🔔 {t('notifyPromptTitle')}</div>
            <p className="mb-4 text-sm text-slate-300">{t('notifyPromptDesc')}</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={acceptNotifyPrompt}
                className="w-full rounded-xl bg-emerald-500/20 px-4 py-2.5 text-sm font-semibold text-emerald-200 ring-1 ring-emerald-400/40 transition hover:bg-emerald-500/30"
              >
                {t('notifyPromptYes')}
              </button>
              <button
                onClick={dismissNotifyPrompt}
                className="w-full rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/15"
              >
                {t('notifyPromptLater')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

