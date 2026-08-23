'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type Room,
  type RoomInvite,
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

const INVITE_ALERT_SECONDS = 7

// Aviso de convite de sala: card pequeno e discreto no canto inferior direito.
// Mostra quem chamou, o nome da sala, um cronômetro de 7s e botões "Ir" e "Fechar".
function InviteAlert({
  fromName,
  fromPhoto,
  roomName,
  onGo,
  dismiss,
}: {
  fromName: string
  fromPhoto: string | null
  roomName: string
  onGo: () => void
  dismiss: () => void
}) {
  const [left, setLeft] = useState(INVITE_ALERT_SECONDS)
  // Guarda o dismiss em um ref para o cronômetro não ser reiniciado quando a
  // tela re-renderizar por outros motivos (vídeo, estado da chamada etc).
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    if (left <= 0) {
      dismissRef.current()
      return
    }
    const t = setTimeout(() => setLeft((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  return (
    <div className="pointer-events-auto w-[19rem] overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 p-3 shadow-2xl shadow-black/50 backdrop-blur">
      <div className="flex items-start gap-2.5">
        {fromPhoto ? (
          <img src={fromPhoto} alt={fromName} className="mt-0.5 h-9 w-9 shrink-0 rounded-full object-cover ring-2 ring-white/10" />
        ) : (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/30 text-sm font-bold text-indigo-200 ring-2 ring-white/10">
            {fromName.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-white">{fromName}</p>
          <p className="truncate text-xs text-slate-400">
            te chamou para &quot;<span className="font-semibold text-emerald-300">{roomName}</span>&quot;
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-white/5 pt-2.5">
        <span className="text-xs font-semibold tabular-nums text-slate-400">{left}s</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onGo}
            className="rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-emerald-600 active:scale-95"
          >
            Ir
          </button>
          <button
            onClick={dismiss}
            className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/20 active:scale-95"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}

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

type Remote = { name: string; photo?: string; streams: MediaStream[] }

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

// Resoluções de captura por qualidade. Usamos valores `ideal` (com teto `max`)
// para o navegador escolher a melhor resolução que o aparelho suportar sem
// forçar muito — assim melhora o HD em celulares fracos sem causar travamento.
const QUALITY_CONSTRAINTS: Record<Quality, MediaTrackConstraints> = {
  auto: {
    frameRate: { ideal: 30, max: 30 },
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
  },
  baixa: {
    frameRate: { ideal: 15, max: 15 },
    width: { ideal: 640, max: 640 },
    height: { ideal: 360, max: 360 },
  },
  media: {
    frameRate: { ideal: 24, max: 24 },
    width: { ideal: 960, max: 960 },
    height: { ideal: 540, max: 540 },
  },
  alta: {
    frameRate: { ideal: 30, max: 30 },
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
  },
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
        {desc && <span className="block text-xs text-slate-200">{desc}</span>}
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
  atualizacoes: ['Atualizações', 'Updates'],
  atualizacoesDesc: ['Novidades e correções de cada versão', "What's new and fixes in each version"],
  avancadoDesc: ['Administrador e mais', 'Admin and more'],
  account: ['Minha conta', 'My account'],
  accountDesc: ['Entrar com o Google e gerenciar sua conta', 'Sign in with Google and manage your account'],
  privacy: ['Privacidade', 'Privacy'],
  privacidadeDesc: ['O que os outros veem de você', 'What others see about you'],
  privacyShowOnline: ['Mostrar "online agora"', 'Show "online now"'],
  privacyShowOnlineDesc: [
    'Deixa seus amigos verem quando você está online',
    'Let friends see when you are online',
  ],
  privacyShowLastseen: ['Permitir "visto por último"', 'Allow "last seen"'],
  privacyShowLastseenDesc: [
    'Deixa seus amigos verem seu último acesso',
    'Let friends see your last access',
  ],
  privacyShowRoom: ['Mostrar a sala em que estou', 'Show the room you are in'],
  privacyShowRoomDesc: [
    'Deixa seus amigos verem o nome da sala',
    'Let friends see the room name',
  ],
  privacyLocked: [
    'Entre com o Google para controlar sua privacidade.',
    'Sign in with Google to control your privacy.',
  ],
  privacyOn: ['Visível', 'Visible'],
  privacyOff: ['Oculto', 'Hidden'],
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
  camerasTabTitle: ['Câmeras ativas', 'Active cameras'],
  screensTabTitle: ['Telas compartilhadas', 'Shared screens'],
  backToProfiles: ['Ver perfis', 'View profiles'],
  seeCamerasBtn: ['Câmeras', 'Cameras'],
  seeScreensBtn: ['Ver telas', 'View screens'],
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
    'Você ficou sozinho(a) nesta sala por mais de 5 minutos. Para manter as salas livres e não ocupar espaço, você foi removido(a) automaticamente. Fique à vontade para entrar de novo quando quiser. 💜',
    'You were alone in this room for over 5 minutes. To keep rooms free and avoid taking up space, you were automatically removed. Feel free to come back whenever you like. 💜',
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
  noiseEchoHint: ['Desligados por padrão para a voz sair natural e clara.', 'Off by default so your voice stays natural and clear.'],
  micSensitivity: ['Sensibilidade do microfone', 'Microphone sensitivity'],
  micSensitivityDesc: ['Ajusta o quanto o microfone capta. Desligado = som natural.', 'Adjusts how much the mic picks up. Off = natural sound.'],
  cameraLabel: ['Câmera', 'Camera'],
  cameraEnhance: ['Melhorar nitidez', 'Enhance sharpness'],
  cameraEnhanceDesc: ['Deixa a imagem mais nítida e com mais qualidade na chamada.', 'Makes the image sharper and higher quality during calls.'],
  cameraFlip: ['Virar câmera (frontal/traseira)', 'Flip camera (front/back)'],
  videoVivid: ['Cores vívidas (contraste e saturação)', 'Vivid colors (contrast and saturation)'],
  videoVividDesc: ['Deixa imagens e vídeos com mais contraste, nitidez e cor. Desligado por padrão para não esquentar o aparelho.', 'Makes images and videos sharper with more contrast and color. Off by default to avoid overheating.'],
  videoVividHint: ['Segure ativado evita superaquecimento.', 'Keep off to avoid overheating.'],
  aboutText: [
    'O Orbit Room é uma plataforma de conversas ao vivo em voz e vídeo, criada para aproximar pessoas e reunir todo mundo em salas compartilhadas em tempo real — não importa a distância.\n\n#Por que o Orbit Room existe?\n\nEstamos sempre conectados, mas muitas vezes distantes. O Orbit Room nasceu para devolver ao mundo digital o calor de uma conversa cara a cara: um lugar simples em que basta entrar numa sala para se sentir junto de verdade.\n\n• Reunir pessoas ao redor de uma conversa viva, sem fricção\n• Trazer de volta a sensação de “estar na mesma sala”, de qualquer lugar\n• Tornar as conversas reais acessíveis e naturais para todos\n\nMais do que um aplicativo de chamadas, é um espaço de presença e conexão — feito para quem quer conversar, e não apenas conectar.',
    'Orbit Room is a live voice and video conversation platform, created to bring people together and gather everyone in shared rooms in real time — no matter the distance.\n\n#Why does Orbit Room exist?\n\nWe are always connected, yet often distant. Orbit Room was born to bring the warmth of a face-to-face conversation back to the digital world: a simple place where you just join a room to truly feel together.\n\n• Bring people together around a living conversation, without friction\n• Bring back the feeling of “being in the same room”, from anywhere\n• Make real conversations accessible and natural for everyone\n\nMore than a calling app, it is a space for presence and connection — made for those who want to talk, not just connect.',
  ],
  aboutCredits: ['Criado por Noah · v0.65', 'Created by Noah · v0.65'],
} as const

// ---- Notas de atualização (changelog) ----
type ChangelogItem = {
  tag: 'novo' | 'correcao' | 'melhoria'
  pt: string
  en: string
}
const CHANGELOG: { version: string; date: string; items: ChangelogItem[] }[] = [
  {
    version: 'v0.65',
    date: 'Ago 2026',
    items: [
      { tag: 'novo', pt: 'Fixar até 3 câmeras na tela cheia, com a sua como a principal.', en: 'Pin up to 3 cameras in fullscreen, with yours as the main one.' },
      { tag: 'novo', pt: 'Câmeras fixadas lado a lado na tela cheia, em retrato e em paisagem.', en: 'Pinned cameras shown side-by-side in fullscreen, in portrait and landscape.' },
      { tag: 'melhoria', pt: 'Tela cheia mostra uma câmera por vez até você fixar alguém.', en: 'Fullscreen shows one camera at a time until you pin someone.' },
      { tag: 'correcao', pt: 'Botão de fixar no lugar certo: na aba Câmeras, somente no computador.', en: 'Pin button in the right place: in the Cameras tab, desktop only.' },
      { tag: 'melhoria', pt: 'Detecção de aparelho (celular ou computador) para controlar quem fixa câmeras.', en: 'Device detection (mobile or desktop) to control who can pin cameras.' },
    ],
  },
  {
    version: 'v0.6',
    date: 'Ago 2026',
    items: [
      { tag: 'novo', pt: 'Nova página de Atualizações no menu de configurações.', en: 'New Updates page in the settings menu.' },
      { tag: 'melhoria', pt: 'Entrar nas salas com o microfone ligado por padrão (modo silencioso continua disponível).', en: 'Join rooms with your mic on by default (silent mode is still available).' },
      { tag: 'melhoria', pt: 'Cada versão agora mostra a data de quando foi lançada.', en: 'Each version now shows its release date.' },
      { tag: 'correcao', pt: 'Microfone mais estável ao ligar e desligar durante a chamada.', en: 'Mic is more stable when toggled during a call.' },
    ],
  },
  {
    version: 'v0.5',
    date: 'Ago 2026',
    items: [
      { tag: 'novo', pt: 'Virar a câmera entre frontal e traseira no celular.', en: 'Flip the camera between front and back on mobile.' },
      { tag: 'novo', pt: 'Modo silencioso para entrar nas salas sem ativar o microfone.', en: 'Silent mode to join rooms without enabling your mic.' },
      { tag: 'correcao', pt: 'Câmera não pisca mais ao ligar e desligar em sequência.', en: 'Camera no longer flickers when toggling it on and off quickly.' },
      { tag: 'correcao', pt: 'Vídeo do outro lado sempre na posição correta, em qualquer aparelho.', en: 'Remote video is now upright on every device.' },
      { tag: 'melhoria', pt: 'Microfone liga e desliga na hora, sem limite.', en: 'Mic toggles instantly, with no limit.' },
    ],
  },
  {
    version: 'v0.4',
    date: 'Jul 2026',
    items: [
      { tag: 'novo', pt: 'Compartilhar a tela com áudio para os participantes.', en: 'Share your screen with audio to other participants.' },
      { tag: 'novo', pt: 'Salas privadas com senha e convites.', en: 'Private rooms with password and invites.' },
      { tag: 'melhoria', pt: 'Conversas do chat salvas por canal.', en: 'Chat messages are now saved per channel.' },
      { tag: 'correcao', pt: 'Som com menos eco e ruído de fundo.', en: 'Less echo and background noise in calls.' },
    ],
  },
  {
    version: 'v0.3',
    date: 'Jun 2026',
    items: [
      { tag: 'novo', pt: 'Entrar com a conta do Google.', en: 'Sign in with your Google account.' },
      { tag: 'novo', pt: 'Lista de amigos e de quem está online.', en: 'Friends list and who is online.' },
      { tag: 'novo', pt: 'Perfil com nome, foto e bio.', en: 'Profile with name, photo and bio.' },
      { tag: 'melhoria', pt: 'Visual reformulado para celular e computador.', en: 'Fresh look for mobile and desktop.' },
    ],
  },
]

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

// Reprocessa o vídeo da câmera em um <canvas> para que a imagem enviada fique
// sempre em pé, independente da rotação do celular. O próprio navegador renderiza
// o vídeo da câmera já na orientação correta; a gente captura essa imagem pronta
// e reenvia. Funciona em iOS (Safari/Chrome) e Android (Chrome), em qualquer
// navegador com suporte a canvas.captureStream().
function reorientCameraStream(
  stream: MediaStream,
  enabled: boolean
): { stream: MediaStream; stop: () => void } {
  const vtrack = stream.getVideoTracks()[0]
  if (!enabled || !vtrack || typeof document === 'undefined') {
    return { stream, stop: () => {} }
  }
  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.srcObject = stream
  void video.play().catch(() => {})

  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 480
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    video.srcObject = null
    return { stream, stop: () => {} }
  }

  const cvs = canvas.captureStream(30)
  const outTrack = cvs.getVideoTracks()[0]
  const final = new MediaStream([outTrack, ...stream.getAudioTracks()])

  let raf = 0
  let running = true
  const draw = () => {
    if (!running) return
    raf = requestAnimationFrame(draw)
    if (video.readyState < 2) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.drawImage(video, 0, 0, w, h)
  }
  raf = requestAnimationFrame(draw)

  return {
    stream: final,
    stop: () => {
      running = false
      cancelAnimationFrame(raf)
      outTrack?.stop()
      video.srcObject = null
      // Libera a fonte original (a câmera) para não acumular capturas abertas a
      // cada religada — acumular câmeras faz o vídeo piscar/sumir no outro lado.
      stream.getTracks().forEach((t) => {
        try {
          t.stop()
        } catch {
          /* noop */
        }
      })
    },
  }
}

export function ShareRoom() {
  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<ChannelId>('sala-1')
  const [inCall, setInCall] = useState(false)
  const [onlineMembers, setOnlineMembers] = useState<Member[]>([])
  const onlineMembersRef = useRef<Member[]>([])
  const [offlineMembers, setOfflineMembers] = useState<Member[]>([])
  const [remotePeers, setRemotePeers] = useState<Record<string, Remote>>({})
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [camOn, setCamOn] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [screenStreaming, setScreenStreaming] = useState(false)
  const [screenWithAudio, setScreenWithAudio] = useState(false)
  // Mudo do áudio da TELA que está sendo compartilhada (controlado pelo alto-falante
  // ao lado do botão "Compartilhar"). Muta a trilha de som para todos os ouvintes.
  const [screenAudioMuted, setScreenAudioMuted] = useState(false)
  // Aba ativa na tela de chamada: perfis padrão, câmeras ou telas compartilhadas.
  const [callView, setCallView] = useState<'profiles' | 'cameras' | 'screens'>('profiles')
  // Stream local reativo (mic/câmera), para a grade reagir na hora que fica pronto.
  const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null)
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

  // Detecção de aparelho: o botão de virar a câmera (frontal/traseira) só faz
  // sentido em celular/tablet, então só aparece em aparelhos móveis.
  const isMobileDevice =
    typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

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

  // ---- Salas personalizadas ----
  const [rooms, setRooms] = useState<Room[]>([]) // salas públicas de todos
  const [myRooms, setMyRooms] = useState<Room[]>([]) // salas que criei
  const [privateRooms, setPrivateRooms] = useState<Room[]>([]) // salas privadas (de todos, ocupadas)
  const [roomInvites, setRoomInvites] = useState<RoomInvite[]>([]) // convites de sala recebidos
  // Avisos ativos de convite (cards pequenos no canto inferior direito).
  const [inviteAlerts, setInviteAlerts] = useState<
    { id: string; fromName: string; fromPhoto: string | null; roomName: string }[]
  >([])
  const closeInviteAlert = useCallback((id: string) => {
    setInviteAlerts((alerts) => alerts.filter((a) => a.id !== id))
  }, [])
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomPrivate, setNewRoomPrivate] = useState(false)
  const [newRoomPassword, setNewRoomPassword] = useState('')
  const [newRoomCapacity, setNewRoomCapacity] = useState(8)
  const [creatingRoom, setCreatingRoom] = useState(false)
  // edição de sala (Minhas salas)
  const [editingRoom, setEditingRoom] = useState<Room | null>(null)
  const [editRoomName, setEditRoomName] = useState('')
  const [editRoomPrivate, setEditRoomPrivate] = useState(false)
  const [editRoomPassword, setEditRoomPassword] = useState('')
  const [editRoomCapacity, setEditRoomCapacity] = useState(8)
  const [savingRoom, setSavingRoom] = useState(false)
  // senha para entrar em sala privada
  const [joinPasswordOpen, setJoinPasswordOpen] = useState(false)
  const [joinPasswordRoom, setJoinPasswordRoom] = useState<Room | null>(null)
  const [joinPasswordValue, setJoinPasswordValue] = useState('')
  const [joinPasswordBusy, setJoinPasswordBusy] = useState(false)
  // convites de sala
  const [inviteRoom, setInviteRoom] = useState<Room | null>(null)
  const [inviteFriends, setInviteFriends] = useState<{ id: string; displayName: string; photo: string | null; online: boolean }[]>([])
  const [inviteLoading, setInviteLoading] = useState(false)
  const roomLabelsRef = useRef<Record<string, string>>({})
  // Convites de sala já vistos (para disparar o alerta só quando chega um novo).
  const seenInvitesRef = useRef<Set<string>>(new Set())
  // Abre a subcategoria "Amigos/Convites" no painel de Configurações.
  const openInvitesTab = useCallback(() => {
    setConfigPane('amigos')
    setConfigOpen(true)
    setMobileTab('config')
  }, [])

  const loadRooms = useCallback(async () => {
    const [pub, priv, mine, inv] = await Promise.all([
      apiClient.get<{ rooms: Room[] }>('/api/rooms'),
      apiClient.get<{ rooms: Room[] }>('/api/rooms?private=1'),
      apiClient.get<{ rooms: Room[] }>('/api/rooms?mine=1'),
      apiClient.get<{ roomInvites: RoomInvite[] }>('/api/rooms?invites=1'),
    ])
    if (pub.success) setRooms(pub.data.rooms)
    if (priv.success) setPrivateRooms(priv.data.rooms)
    if (mine.success) setMyRooms(mine.data.rooms)
    if (inv.success) {
      setRoomInvites(inv.data.roomInvites)
      // Alerta no site para cada convite de sala novo.
      for (const invite of inv.data.roomInvites) {
        if (seenInvitesRef.current.has(invite.id)) continue
        seenInvitesRef.current.add(invite.id)
        setInviteAlerts((alerts) => [
          ...alerts,
          { id: invite.id, fromName: invite.fromName, fromPhoto: invite.fromPhoto ?? null, roomName: invite.roomName },
        ])
      }
    }
  }, [openInvitesTab])

  useEffect(() => {
    const map: Record<string, string> = {}
    for (const r of [...rooms, ...myRooms, ...privateRooms]) map[r.id] = r.name
    roomLabelsRef.current = map
  }, [rooms, myRooms, privateRooms])

  useEffect(() => {
    void loadRooms()
    // Atualiza periodicamente para refletir quem entrou/saiu e convites novos.
    const id = setInterval(() => void loadRooms(), 8000)
    return () => clearInterval(id)
  }, [loadRooms])

  const createRoom = useCallback(async () => {
    const name = newRoomName.trim()
    if (!name) return
    setCreatingRoom(true)
    const res = await apiClient.post<{ room: Room }>('/api/rooms', {
      name,
      isPrivate: newRoomPrivate,
      password: newRoomPassword.trim(),
      capacity: newRoomCapacity,
    })
    setCreatingRoom(false)
    if (!res.success) {
      toast.error(res.error || 'Não foi possível criar a sala.')
      return
    }
    setNewRoomName('')
    setNewRoomPrivate(false)
    setNewRoomPassword('')
    setNewRoomCapacity(8)
    await loadRooms()
    setInicioView('minhas')
    toast.success('Sala criada! Entre nela pela aba Minhas salas.')
  }, [newRoomName, newRoomPrivate, newRoomPassword, newRoomCapacity, loadRooms])

  const saveRoom = useCallback(async () => {
    if (!editingRoom) return
    const name = editRoomName.trim()
    if (!name) return
    setSavingRoom(true)
    const res = await apiClient.patch<{ room: Room }>('/api/rooms', {
      id: editingRoom.id,
      name,
      isPrivate: editRoomPrivate,
      password: editRoomPassword.trim(),
      capacity: editRoomCapacity,
    })
    setSavingRoom(false)
    if (!res.success) {
      toast.error(res.error || 'Não foi possível salvar as alterações.')
      return
    }
    setEditingRoom(null)
    await loadRooms()
    toast.success('Sala atualizada.')
  }, [editingRoom, editRoomName, editRoomPrivate, editRoomPassword, editRoomCapacity, loadRooms])

  const startEditRoom = useCallback(
    (room: Room) => {
      setEditingRoom(room)
      setEditRoomName(room.name)
      setEditRoomPrivate(room.isPrivate)
      setEditRoomPassword('')
      setEditRoomCapacity(room.capacity > 0 ? room.capacity : 8)
    },
    []
  )

  const deleteRoom = useCallback(
    async (id: string) => {
      const res = await apiClient.delete<{ ok: boolean }>(`/api/rooms?id=${encodeURIComponent(id)}`)
      if (!res.success) {
        toast.error(res.error || 'Não foi possível excluir a sala.')
        return
      }
      if (channel === id) {
        setChannel('sala-1')
        setInCall(false)
        inCallRef.current = false
        channelRef.current = 'sala-1'
      }
      void loadRooms()
    },
    [channel, loadRooms]
  )
  // Sub-tela do painel de Configurações no mobile (cada categoria abre a sua).
  const [configPane, setConfigPane] = useState<
    | 'menu'
    | 'conta'
    | 'perfil'
    | 'privacidade'
    | 'avancado'
    | 'audio'
    | 'aparencia'
    | 'notificacoes'
    | 'silencioso'
    | 'idioma'
    | 'limpeza'
    | 'sobre'
    | 'atualizacoes'
    | 'online'
    | 'amigos'
  >('menu')

  // ----- Preferências globais (persistidas no navegador) -----
  type Settings = {
    volume: number
    noiseSuppression: boolean
    echoCancellation: boolean
    micSensitivity: boolean
    micGain: number
    cameraEnhance: boolean
    videoVivid: boolean
    cameraFacing: 'user' | 'environment'
    defaultQuality: Quality
    theme: 'dark' | 'light'
    notifications: boolean
    silentMode: boolean
    language: 'pt' | 'en'
  }
  const SETTINGS_KEY = 'share_room_settings_v2'
  const DEFAULT_SETTINGS: Settings = {
    volume: 1,
    noiseSuppression: true,
    echoCancellation: true,
    micSensitivity: false,
    micGain: 1,
    cameraEnhance: false,
    videoVivid: false,
    cameraFacing: 'user',
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
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Settings>
        // Eco e ruído ficam sempre ativos ao entrar (a resolução não dá pra
        // melhorar o áudio com eles desligados). Só desliga durante a sessão.
        saved.noiseSuppression = true
        saved.echoCancellation = true
        return { ...DEFAULT_SETTINGS, ...saved }
      }
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

  // ----- Privacidade (persistida no servidor, pois controla o que os outros veem) -----
  const [privacy, setPrivacy] = useState<{
    showOnline: boolean
    showLastseen: boolean
    showRoom: boolean
  }>({ showOnline: true, showLastseen: true, showRoom: true })
  const [privacyLoaded, setPrivacyLoaded] = useState(false)

  useEffect(() => {
    if (!authUser) return
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.profile?.privacy) setPrivacy(d.profile.privacy)
      })
      .catch(() => {})
      .finally(() => setPrivacyLoaded(true))
  }, [authUser])

  const setPrivacyFlag = useCallback(
    (key: 'showOnline' | 'showLastseen' | 'showRoom', v: boolean) => {
      setPrivacy((prev) => {
        const next = { ...prev, [key]: v }
        fetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ privacy: next }),
        }).catch(() => {})
        return next
      })
    },
    []
  )

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
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('admin-changed', { detail: { isAdmin: true } }))
    }
  }, [])

  const engineRef = useRef<RtcEngine | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  // Stream ORIGINAL do microfone (antes do processamento de sensibilidade).
  // Ao sair da chamada ele precisa ser parado explicitamente — desligar só a
  // cópia processada (localStreamRef) não libera o microfone no iOS/mobile.
  const micSourceRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  // Limpeza da correção de orientação da câmera (parar canvas/stream).
  const orientStopRef = useRef<(() => void) | null>(null)
  // Última vez que a câmera foi ligada/desligada (usado para evitar religação
  // rápida, que faz o vídeo piscar no outro lado).
  const lastCamToggleAtRef = useRef(0)
  const CAM_TOGGLE_COOLDOWN = 2500
  const clientIdRef = useRef('')
  const nameRef = useRef('')
  const channelRef = useRef<ChannelId>('sala-1')
  const inCallRef = useRef(false)
  const remotePeersRef = useRef<Record<string, Remote>>({})
  const screenTrackIdsRef = useRef<Record<string, string[]>>({})
  const seenChatRef = useRef<Set<string>>(new Set())
  const profileRef = useRef<Profile>({ name: '' })
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderStreamRef = useRef<MediaStream | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  // Cadeia de processamento de ganho do microfone (WebAudio) aplicada ao stream
  // local antes de enviar. Guarda os nós para poder recalibrar em tempo real e
  // desconectar ao trocar de stream.
  const micGainRef = useRef<{ source: MediaStreamAudioSourceNode; gain: GainNode; dest: MediaStreamAudioDestinationNode } | null>(null)

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
      device: isMobileDevice ? 'mobile' : 'desktop',
    })
  }, [isMobileDevice])

  // Ao recarregar ou fechar a página, sai da sala automaticamente (sem precisar
  // apertar o botão sair). Evita deixar "fantasma": o usuário some da contagem
  // da sala na hora, em vez de continuar marcado como presente após o refresh.
  useEffect(() => {
    const sendLeave = () => {
      const id = clientIdRef.current
      if (!id) return
      try {
        const body = JSON.stringify({ action: 'leave', clientId: id })
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon('/api/rtc', new Blob([body], { type: 'application/json' }))
        } else {
          void fetch('/api/rtc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          })
        }
      } catch {
        /* noop */
      }
    }
    const onHide = () => sendLeave()
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
    }
  }, [])

  // Quando a aba volta para o foco após ficar em segundo plano (ex.: o usuário
  // foi ao Instagram e voltou), o navegador pausa os timers do site e a chamada
  // pode "cair". Aqui a gente repara a conexão na hora: renova a presença no
  // servidor e reconstrói as conexões WebRTC com os participantes.
  const hiddenSinceRef = useRef<number | null>(null)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = Date.now()
        // Renova o "last_seen" antes de ficar em segundo plano, para o servidor
        // não achar que saímos da sala enquanto a aba está suspensa.
        registerPresence()
        return
      }
      // Ficou visível de novo.
      const awayMs = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0
      hiddenSinceRef.current = null
      if (!inCallRef.current || !channelRef.current) return
      registerPresence()
      if (awayMs < 1500) return
      // Mantém a chamada viva: reinicia o transporte (ICE) de quem já existe e
      // recria apenas um peer que tenha sumido de verdade. Nada de apagar card
      // nem reanunciar no servidor — a conexão continua a mesma.
      const engine = engineRef.current
      const myId = clientIdRef.current
      if (!engine || !myId) return
      const seen = new Set<string>()
      for (const m of onlineMembersRef.current) {
        if (m.channel !== channelRef.current || m.clientId === myId) continue
        seen.add(m.clientId)
        if (engine.hasPeer(m.clientId)) engine.restartIce(m.clientId)
        else engine.addPeer(m.clientId)
      }
      // Segurança: também reinicia/recria qualquer peer ainda rastreado localmente.
      for (const pid of Object.keys(remotePeersRef.current)) {
        if (pid !== myId && !seen.has(pid)) {
          if (engine.hasPeer(pid)) engine.restartIce(pid)
          else engine.addPeer(pid)
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [registerPresence])

  const bind = useCallback((el: HTMLMediaElement | null, stream: MediaStream | null) => {
    if (!el || !stream) return
    if (el.srcObject !== stream) el.srcObject = stream
    // Mantém a reprodução automática sempre ligada. Ao reconectar um elemento
    // (ex.: ao sair da tela cheia), garante que o vídeo volte a rodar em tempo
    // real em vez de ficar congelado esperando um "play" manual.
    el.autoplay = true
    if (typeof el.play === 'function') void el.play().catch(() => undefined)
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

  // Ao voltar de uma aba em segundo plano (trocar de página/minimizar a janela
  // no desktop ou no celular), o navegador pode deixar o vídeo da câmera e o
  // compartilhamento de tela num frame congelado. Aqui forçamos a reprodução ao
  // vivo: reatribuímos a stream e chamamos play() de todos os elementos, para o
  // vídeo voltar em tempo real assim que a aba volta ao foco.
  useEffect(() => {
    const resumeOnVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (document.fullscreenElement) return
      mediaElsRef.current.forEach((el) => {
        try {
          el.autoplay = true
          const s = el.srcObject as MediaStream | null
          if (typeof el.play === 'function' && el.paused) void el.play().catch(() => undefined)
          if (typeof s?.getVideoTracks === 'function' && s.getVideoTracks().length > 0) {
            el.srcObject = null
            el.srcObject = s
            if (typeof el.play === 'function') void el.play().catch(() => undefined)
          }
        } catch {
          /* elemento já removido do DOM */
        }
      })
    }
    document.addEventListener('visibilitychange', resumeOnVisible)
    return () => document.removeEventListener('visibilitychange', resumeOnVisible)
  }, [])

  // Reproduz o áudio remoto mesmo se o navegador bloquear o autoplay inicial
  // (política de autoplay): ao entrar na chamada ou ganhar novos participantes,
  // tenta dar play algumas vezes, para o som nunca ficar mudo "à toa" com o
  // volume ligado.
  useEffect(() => {
    if (!inCall) return
    let tries = 0
    const timer = window.setInterval(() => {
      mediaElsRef.current.forEach((el) => {
        try {
          if (el.paused) void el.play().catch(() => undefined)
        } catch {
          /* elemento já removido do DOM */
        }
      })
      tries += 1
      if (tries >= 4) window.clearInterval(timer)
    }, 350)
    return () => window.clearInterval(timer)
  }, [inCall])

  // Ao sair da tela cheia (desktop ou mobile/iOS), o navegador costuma pausar o
  // vídeo — o que congela o quadradinho numa imagem parada. Este ouvinte retoma
  // automaticamente a reprodução de todos os participantes assim que a tela
  // cheia é fechada, para a câmera continuar em tempo real sem precisar de play.
  useEffect(() => {
    const resumeOnExit = () => {
      if (document.fullscreenElement) return
      mediaElsRef.current.forEach((el) => {
        try {
          el.autoplay = true
          if (typeof el.play === 'function' && el.paused) void el.play().catch(() => undefined)
        } catch {
          /* elemento já removido do DOM */
        }
      })
    }
    document.addEventListener('fullscreenchange', resumeOnExit)
    document.addEventListener('webkitfullscreenchange', resumeOnExit)
    return () => {
      document.removeEventListener('fullscreenchange', resumeOnExit)
      document.removeEventListener('webkitfullscreenchange', resumeOnExit)
    }
  }, [])

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

  // Exibição "tela cheia": retângulo em pé (celular, com laterais pretas) quando
  // a câmera está em retrato, ou tela cheia normal quando está deitada (paisagem).
  // A orientação é detectada a partir do próprio vídeo e acompanha ao vivo a
  // rotação do celular de quem transmite.
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [expandedPortrait, setExpandedPortrait] = useState(false)
  // Câmeras fixadas para a tela cheia em conjunto (até 3). A primeira é sempre a
  // própria câmera de quem fixou; as seguintes são câmeras dos participantes.
  const [pinnedIds, setPinnedIds] = useState<string[]>([])
  const handleExpandedSize = useCallback((video: HTMLVideoElement) => {
    const w = video.videoWidth || 0
    const h = video.videoHeight || 0
    if (w > 0 && h > 0) setExpandedPortrait(w < h)
  }, [])
  const toggleTileFullscreen = useCallback((id: string) => {
    setExpandedTileId((prev) => {
      if (prev === id) return null
      return id
    })
    const el = tileElsRef.current[id]
    const video = el?.querySelector('video') as HTMLVideoElement | null
    const w = video?.videoWidth || 0
    const h = video?.videoHeight || 0
    setExpandedPortrait(w > 0 && h > 0 ? w < h : false)
  }, [])

  // Chave ESTÁVEL de um tile para fixar. Não depende do id interno do tile
  // (que muda ao girar a câmera ou reconectar), então a fixação não some sozinha
  // ao trocar da traseira pra frontal, nem trava por quem desconectou.
  const pinKeyOf = (tile: Tile): string | null => {
    if (!tile.hasVideo || tile.isScreen) return null
    if (tile.isLocal) return 'local-cam'
    if (tile.peerId) return `peer:${tile.peerId}`
    return null
  }

  // Fixa/desfixa uma câmera para a tela cheia em conjunto (até 3). A própria
  // câmera de quem fixa entra sempre como a primeira. Participantes que saíram
  // saem da conta automaticamente, para não ocuparem o limite nem impedirem
  // novas fixações quando reconectarem.
  const togglePin = useCallback(
    (tile: Tile) => {
      setPinnedIds((prev) => {
        const key = pinKeyOf(tile)
        if (!key) return prev
        // Só contam fixações que ainda são reais (tiles vivos agora mesmo).
        const liveKeys = prev.filter((k) => {
          if (k === 'local-cam') {
            return camOn && !!localMediaStream?.getVideoTracks().length
          }
          if (k.startsWith('peer:')) {
            const pid = k.slice('peer:'.length)
            const peer = remotePeers[pid]
            if (!peer) return false
            return peer.streams.some((s) => s.getVideoTracks().length > 0)
          }
          return false
        })
        if (liveKeys.includes(key)) return liveKeys.filter((k) => k !== key)
        if (liveKeys.length >= 3) {
          toast.info('Máximo de 3 câmeras fixadas')
          return liveKeys
        }
        const selfId = 'local-cam'
        let next = liveKeys
        // Garante que a própria câmera fica em primeiro ao começar a fixar.
        if (selfId !== key && !next.includes(selfId)) {
          next = [selfId, ...next].slice(0, 3)
        }
        return [...next, key].slice(0, 3)
      })
    },
    [camOn, localMediaStream, remotePeers]
  )

  // O botão de fixar só aparece no COMPUTADOR (não na versão mobile). No desktop,
  // aparece nas câmeras de todos os outros participantes — menos na própria câmera
  // de quem está fixando (ela entra automaticamente como a principal, nº 1). Telas
  // compartilhadas, não. Cada um monta o seu próprio conjunto — é individual.
  const pinnable = (tile: Tile): boolean => {
    if (isMobileDevice) return false
    if (tile.isLocal) return false
    if (!tile.hasVideo || tile.isScreen) return false
    return true
  }

  // Vira a câmera entre frontal/traseira, recapturando apenas o vídeo local.
  const flipCamera = useCallback(() => {
    if (!camOn) return
    const next = settings.cameraFacing === 'environment' ? 'user' : 'environment'
    setSetting('cameraFacing', next)
    toast.info(next === 'environment' ? 'Câmera traseira' : 'Câmera frontal')
  }, [camOn, settings.cameraFacing, setSetting])

  // Aplica as melhorias de nitidez na trilha de vídeo ativa, mas só com os
  // ajustes que a câmera realmente suporta. Aplicar um ajuste não suportado
  // pode travar o feed em preto, então conferimos com getCapabilities() antes.
  const applyCameraEnhance = useCallback(
    (stream: MediaStream | null) => {
      if (!settings.cameraEnhance) return
      const vtrack = stream?.getVideoTracks()[0]
      if (!vtrack) return
      let caps: MediaTrackCapabilities = {}
      try {
        caps = typeof vtrack.getCapabilities === 'function' ? vtrack.getCapabilities() : {}
      } catch {
        caps = {}
      }
      const adv: Record<string, number> = {}
      if ('sharpness' in caps) adv.sharpness = 1
      if ('contrast' in caps) adv.contrast = 1.06
      if ('saturation' in caps) adv.saturation = 1.12
      if ('brightness' in caps) adv.brightness = 1.03
      if (Object.keys(adv).length === 0) return
      void vtrack
        .applyConstraints({ advanced: [adv as unknown as MediaTrackConstraints] })
        .catch(() => {
          /* câmera não aceitou os ajustes — mantém a imagem original */
        })
    },
    [settings.cameraEnhance]
  )

  // Ao ligar/desligar a nitidez, reaplica (ou limpa) os ajustes no feed atual.
  useEffect(() => {
    if (!settings.cameraEnhance) {
      const vtrack = localStreamRef.current?.getVideoTracks()[0]
      if (vtrack) void vtrack.applyConstraints({ advanced: [] }).catch(() => {})
      return
    }
    applyCameraEnhance(localStreamRef.current)
  }, [settings.cameraEnhance, applyCameraEnhance])

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
    setLocalMediaStream(stream)
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

  // Aplica o ganho de sensibilidade a um stream de microfone via WebAudio.
  // Devolve o próprio stream quando a sensibilidade está desligada ou o ganho é
  // 1x (som natural), para não adicionar latência/processamento desnecessário.
  const applyMicGain = useCallback(
    (stream: MediaStream): MediaStream => {
      const audioTrack = stream.getAudioTracks()[0]
      // Guarda o stream original do microfone para poder parar o hardware ao
      // sair da chamada (a cópia processada não libera o mic no iOS/mobile).
      const prevMic = micSourceRef.current
      if (prevMic && prevMic !== stream) {
        try {
          prevMic.getTracks().forEach((t) => t.stop())
        } catch {
          /* noop */
        }
      }
      micSourceRef.current = stream
      // Cria a cadeia sempre que a sensibilidade está ligada — mesmo em 1x — para
      // que o slider continue ajustando o ganho em tempo real, sem recapturar o
      // microfone a cada movimento.
      const doGain = settings.micSensitivity && audioTrack
      if (!doGain) {
        if (micGainRef.current) {
          try {
            micGainRef.current.source.disconnect()
            micGainRef.current.gain.disconnect()
            micGainRef.current.dest.disconnect()
          } catch {
            /* noop */
          }
          micGainRef.current = null
        }
        return stream
      }
      const ctx = ensureAudioCtx()
      if (!ctx) return stream
      // Desconecta a cadeia anterior (caso troque o stream com sensibilidade ligada).
      if (micGainRef.current) {
        try {
          micGainRef.current.source.disconnect()
          micGainRef.current.gain.disconnect()
          micGainRef.current.dest.disconnect()
        } catch {
          /* noop */
        }
      }
      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = settings.micGain
      const dest = ctx.createMediaStreamDestination()
      source.connect(gain).connect(dest)
      micGainRef.current = { source, gain, dest }
      const processed = new MediaStream([
        ...dest.stream.getAudioTracks(),
        ...stream.getVideoTracks(),
      ])
      // Garante estado de habilitado do áudio coerente com o original.
      const origEnabled = audioTrack.enabled
      processed.getAudioTracks().forEach((t) => (t.enabled = origEnabled))
      return processed
    },
    [ensureAudioCtx, settings.micSensitivity, settings.micGain]
  )

  const reacquire = useCallback(
    async (withVideo: boolean, keepMicMuted = false) => {
      if (!inCallRef.current) return
      try {
        const videoConstraints: MediaTrackConstraints = {
          ...(settings.defaultQuality === 'auto'
            ? QUALITY_CONSTRAINTS.auto
            : QUALITY_CONSTRAINTS[settings.defaultQuality]),
          facingMode: { ideal: settings.cameraFacing === 'environment' ? 'environment' : 'user' },
        }
        // Parâmetros de captura: eco/ruído só ativos quando o usuário escolher.
        // O ganho automático só liga quando alguma opção de tratamento estiver
        // ativa — desligado, a voz sai natural e sem abafar.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl:
              !settings.micSensitivity &&
              (settings.echoCancellation || settings.noiseSuppression),
          },
          video: withVideo ? videoConstraints : false,
        })
        // Se o microfone estava mudo, mantém mudo ao ativar câmera/tela.
        stream.getAudioTracks().forEach((t) => (t.enabled = !keepMicMuted))
        // Corrige a orientação do vídeo no celular para o outro lado sempre ver
        // em pé, mesmo ao deitar/girar o aparelho. No desktop não muda nada.
        orientStopRef.current?.()
        const oriented = reorientCameraStream(stream, isMobileDevice)
        orientStopRef.current = oriented.stop
        const outgoing = applyMicGain(oriented.stream)
        replaceLocalStream(outgoing)
        setMicOn(!keepMicMuted)
        applyQualityToStreams(settings.defaultQuality)
      } catch {
        toast.error('Não foi possível acessar microfone/câmera')
      }
    },
    [replaceLocalStream, settings.echoCancellation, settings.noiseSuppression, settings.micSensitivity, settings.cameraFacing, settings.defaultQuality, applyMicGain, applyQualityToStreams, isMobileDevice]
  )

  // Quando o usuário liga/desliga o corte de ruído, o eco ou a sensibilidade,
  // reaplica na hora na chamada atual (sem precisar sair e entrar de novo).
  useEffect(() => {
    if (!inCallRef.current) return
    void reacquire(camOn, !micOn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.noiseSuppression, settings.echoCancellation, settings.micSensitivity])

  // Aplica os ajustes de eco/ruído/ganho diretamente na trilha de áudio ativa,
  // em tempo real, sem reabrir o microfone. Garante que ligar o interruptor de
  // Eco ou Ruído realmente ative o recurso no momento do clique.
  useEffect(() => {
    const stream = localStreamRef.current
    if (!stream) return
    const track = stream.getAudioTracks()[0]
    if (!track) return
    void track
      .applyConstraints({
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl:
          !settings.micSensitivity &&
          (settings.echoCancellation || settings.noiseSuppression),
      })
      .catch(() => {
        /* navegador não permitiu aplicar ao vivo — o reacquire reabre o mic */
      })
  }, [settings.echoCancellation, settings.noiseSuppression, settings.micSensitivity])

  // Quando o usuário vira a câmera (frontal/traseira), recaptura o vídeo local.
  useEffect(() => {
    if (!inCallRef.current || !camOn) return
    void reacquire(true, !micOn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.cameraFacing])

  // O ganho (slider) é recalibrado em tempo real no nó já ativo, sem recapturar
  // o microfone. Só precisa recapturar ao ligar/desligar a sensibilidade (acima).
  useEffect(() => {
    if (!micGainRef.current) return
    micGainRef.current.gain.gain.value = settings.micGain
  }, [settings.micGain, settings.micSensitivity])

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
          const screenIds = screenTrackIdsRef.current[peerId] ?? []
          const videoId = stream.getVideoTracks()[0]?.id ?? ''
          const isScreen = videoId !== '' && screenIds.includes(videoId)
          // Guarda no máx. um stream com o mesmo id (evita duplicar na lista).
          let streams = (prev ? prev.streams : []).filter((s) => s.id !== stream.id)
          if (isScreen) {
            // Tela compartilhada: adiciona SEM apagar a câmera (o usuário pode
            // manter câmera + tela ligadas ao mesmo tempo).
            streams.push(stream)
          } else {
            // Stream normal (câmera/mic): substitui o stream "normal" anterior
            // (evita duplicar o perfil ao renegociar), mas preserva quaisquer
            // telas que já estejam ativas.
            const keptScreens = streams.filter((s) => {
              const vid = s.getVideoTracks()[0]?.id ?? ''
              return screenIds.includes(vid)
            })
            streams = [...keptScreens, stream]
          }
          remotePeersRef.current = {
            ...remotePeersRef.current,
            [peerId]: { name: prev?.name ?? 'Usuário', photo: prev?.photo, streams },
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
        if (peerId !== clientIdRef.current) {
          // Se já existe um peer com esse clientId (ex.: o outro usuário recarregou
          // a página e reentrou com o MESMO id), recria a conexão: remove o peer
          // antigo — que pode estar numa conexão morta — e abre um novo. Sem isso,
          // o áudio do microfone dele não volta até sair/entrar da sala de novo.
          if (engine.hasPeer(peerId)) {
            engine.removePeer(peerId)
          }
          engine.addPeer(peerId)
        }
        const existing = remotePeersRef.current[peerId]
        remotePeersRef.current = {
          ...remotePeersRef.current,
          [peerId]: existing
            ? { ...existing, name: msg.member.name, photo: msg.member.photo }
            : { name: msg.member.name, photo: msg.member.photo, streams: [] },
        }
        setRemotePeers({ ...remotePeersRef.current })
        // Notificação (se ativada nas Configurações) quando alguém entra na sala.
        if (settings.notifications && peerId !== clientIdRef.current && document.hidden) {
          try {
            new Notification(`${msg.member.name} ${t('notifyJoined')} ${roomLabelsRef.current[channelRef.current] ?? channelLabel(channelRef.current)}`, {
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
            new Notification(`${name} ${t('notifyLeft')} ${roomLabelsRef.current[channelRef.current] ?? channelLabel(channelRef.current)}`, {
              body: t('notifyBodyLeft'),
            })
          } catch {
            /* noop */
          }
        }
      } else if (msg.type === 'peer-updated') {
        const peerId = msg.member.clientId
        const existing = remotePeersRef.current[peerId]
        remotePeersRef.current = {
          ...remotePeersRef.current,
          [peerId]: existing
            ? { ...existing, name: msg.member.name, photo: msg.member.photo }
            : { name: msg.member.name, photo: msg.member.photo, streams: [] },
        }
        setRemotePeers({ ...remotePeersRef.current })
      } else if (msg.type === 'channel-state') {
        const peers = msg.members.filter((m) => m.clientId !== clientIdRef.current)
        // Monta o card de quem já está na sala e cria a conexão com cada um —
        // assim ninguém fica invisível enquanto o áudio ainda não chegou.
        peers.forEach((m) => {
          engine.addPeer(m.clientId)
          const existing = remotePeersRef.current[m.clientId]
          remotePeersRef.current = {
            ...remotePeersRef.current,
            [m.clientId]: existing
              ? { ...existing, name: m.name, photo: m.photo }
              : { name: m.name, photo: m.photo, streams: [] },
          }
        })
        setRemotePeers({ ...remotePeersRef.current })
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
        onlineMembersRef.current = res.data?.members ?? []
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
  }, [sendSignalBody, settings.notifications, registerPresence, t])

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
    async (channelId: ChannelId, password?: string) => {
      if (!clientIdRef.current) return
      // Só evita clicar de novo quando já estamos DENTRO desse canal.
      // (O "sala-1" é o padrão da página, então antes de entrar ele não pode bloquear.)
      if (inCallRef.current && channelId === channelRef.current) return
      engineRef.current?.closeAll()
      remotePeersRef.current = {}
      screenTrackIdsRef.current = {}
      setRemotePeers({})
      orientStopRef.current?.()
      orientStopRef.current = null
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
          password: password ?? '',
          device: isMobileDevice ? 'mobile' : 'desktop',
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
      // Captura o microfone ANTES de criar as conexões com quem já está na sala.
      // Assim o stream local (com o áudio) já está anexado quando o peer é criado,
      // e a negociação WebRTC entrega o som dos dois lados de imediato. Se criasse
      // os peers primeiro, os dois lados negociavam ao mesmo tempo e o navegador
      // descartava uma das ofertas — o recém-chegado ficava mudo ou desaparecia.
      if (settings.silentMode) {
        setMicOn(false)
      } else {
        // Padrão: entra com o microfone ligado (fala direto). Quem quer entrar
        // mudo usa o "modo silencioso" nas configurações.
        await reacquire(false)
      }
      // Cria as conexões com quem já está na sala E monta o card de cada um na
      // hora (nome/foto), para ninguém ficar invisível. Antes, o card só era
      // montado quando o áudio da pessoa chegava — se o fluxo atrasasse ou não
      // chegasse, quem já estava na sala sumia (fantasma), mesmo o contador
      // mostrando a sala ocupada.
      res.data.members.forEach((m) => {
        engineRef.current?.addPeer(m.clientId)
        const existing = remotePeersRef.current[m.clientId]
        remotePeersRef.current = {
          ...remotePeersRef.current,
          [m.clientId]: existing
            ? { ...existing, name: m.name, photo: m.photo }
            : { name: m.name, photo: m.photo, streams: [] },
        }
      })
      setRemotePeers({ ...remotePeersRef.current })
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
    [reacquire, replaceLocalStream, settings.silentMode, isMobileDevice]
  )

  // Abre uma sala: pede senha se for privada, senão entra direto.
  // Quem tem convite ativo entra sem pedir senha.
  const openRoom = useCallback(
    (room: Room) => {
      const invited = roomInvites.some((i) => i.roomId === room.id)
      if (room.hasPassword && !invited) {
        setJoinPasswordRoom(room)
        setJoinPasswordValue('')
        setJoinPasswordOpen(true)
      } else {
        void joinChannel(room.id)
      }
    },
    [joinChannel, roomInvites]
  )
  const submitJoinPassword = useCallback(async () => {
    if (!joinPasswordRoom) return
    setJoinPasswordBusy(true)
    try {
      await joinChannel(joinPasswordRoom.id, joinPasswordValue)
    } finally {
      setJoinPasswordBusy(false)
    }
    setJoinPasswordOpen(false)
    setJoinPasswordRoom(null)
  }, [joinPasswordRoom, joinPasswordValue, joinChannel])
  const openInvite = useCallback(async (room: Room) => {
    setInviteRoom(room)
    setInviteLoading(true)
    try {
      const res = await apiClient.get<{ friends: { id: string; name: string; photo: string | null; online: boolean }[] }>('/api/social')
      const friends =
        res.success && res.data?.friends
          ? res.data.friends.map((f) => ({
              id: f.id,
              displayName: f.name,
              photo: f.photo,
              online: f.online,
            }))
          : []
      setInviteFriends(friends)
    } finally {
      setInviteLoading(false)
    }
  }, [])

  const [inviteSending, setInviteSending] = useState<string | null>(null)
  const sendRoomInvite = useCallback(async (friendId: string) => {
    if (!inviteRoom) return
    setInviteSending(friendId)
    try {
      const res = await apiClient.post('/api/rooms/invite', {
        roomId: inviteRoom.id,
        toUserId: friendId,
      })
      if (res.success) {
        toast.success('Convite enviado!')
        setInviteRoom(null)
      } else {
        toast.error(res.error || 'Não foi possível enviar o convite.')
      }
    } finally {
      setInviteSending(null)
    }
  }, [inviteRoom])

  const leaveChannel = useCallback(() => {
    engineRef.current?.closeAll()
    remotePeersRef.current = {}
    setRemotePeers({})
    orientStopRef.current?.()
    orientStopRef.current = null
    replaceLocalStream(null)
    // Desliga o stream ORIGINAL do microfone (não apenas a cópia processada) e
    // desconecta o processamento de sensibilidade. Isso libera o microfone no
    // iOS/mobile, sem precisar recarregar a página.
    if (micSourceRef.current) {
      try {
        micSourceRef.current.getTracks().forEach((t) => t.stop())
      } catch {
        /* noop */
      }
      micSourceRef.current = null
    }
    try {
      if (micGainRef.current) {
        micGainRef.current.source.disconnect()
        micGainRef.current.gain.disconnect()
        micGainRef.current.dest.disconnect()
      }
    } catch {
      /* noop */
    }
    micGainRef.current = null
    setCamOn(false)
    setMicOn(false)
    setScreenStreaming(false)
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    seenChatRef.current = new Set()
    setChat([])
    setCallView('profiles')
    setExpandedTileId(null)
    setPinnedIds([])
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

  const toggleCam = useCallback(async () => {
    const now = Date.now()
    // Trava a religação rápida: desligar e religar em menos de 2,5s faz a câmera
    // piscar/sumir para o outro lado. Exige um respiro entre os toggles.
    if (!camOn && now - lastCamToggleAtRef.current < CAM_TOGGLE_COOLDOWN) {
      toast.info('Aguarde um instante para religar a câmera')
      return
    }
    lastCamToggleAtRef.current = now
    const next = !camOn
    const engine = engineRef.current
    const local = localStreamRef.current

    if (!next) {
      // Desligar câmera: para SOMENTE o vídeo local, mantendo o microfone intacto
      // (nada de recriar o áudio — isso era o que fazia o som mutar).
      setCamOn(false)
      const vids = local?.getVideoTracks() ?? []
      vids.forEach((t) => {
        t.stop()
        engine?.removeTrack(t)
      })
      if (local && vids.length > 0) {
        vids.forEach((t) => local.removeTrack(t))
        setLocalMediaStream(local)
      }
      orientStopRef.current?.()
      orientStopRef.current = null
      return
    }

    // Ligar câmera: captura apenas o vídeo e o adiciona ao stream local atual,
    // preservando o microfone do jeito que está (ligado ou mudo).
    try {
      const videoConstraints: MediaTrackConstraints = {
        ...(settings.defaultQuality === 'auto'
          ? QUALITY_CONSTRAINTS.auto
          : QUALITY_CONSTRAINTS[settings.defaultQuality]),
        facingMode: { ideal: settings.cameraFacing === 'environment' ? 'environment' : 'user' },
      }
      const vstream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints })
      if (!local) {
        // Não havia stream local ainda (ex.: sem microfone) — recria com áudio+vídeo.
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl:
              !settings.micSensitivity &&
              (settings.echoCancellation || settings.noiseSuppression),
          },
        })
        const merged = new MediaStream([
          ...audioStream.getAudioTracks(),
          ...vstream.getVideoTracks(),
        ])
        vstream.getTracks().forEach((t) => t.stop())
        const outgoing = applyMicGain(merged)
        replaceLocalStream(outgoing)
        setCamOn(true)
        setMicOn(!micOn)
        applyQualityToStreams(settings.defaultQuality)
        return
      }
      const oriented = reorientCameraStream(vstream, isMobileDevice)
      const outVid = oriented.stream.getVideoTracks()[0]
      if (outVid) {
        local.addTrack(outVid)
        engine?.addTrack(outVid, local)
        setCamOn(true)
        setLocalMediaStream(local)
        orientStopRef.current = oriented.stop
      } else {
        vstream.getTracks().forEach((t) => t.stop())
        setCamOn(true)
      }
    } catch {
      toast.error('Não foi possível acessar a câmera')
    }
  }, [
    camOn,
    micOn,
    replaceLocalStream,
    applyMicGain,
    applyQualityToStreams,
    settings.cameraFacing,
    settings.defaultQuality,
    settings.echoCancellation,
    settings.noiseSuppression,
    settings.micSensitivity,
    isMobileDevice,
  ])

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
      // Detecção de suporte + orientação por aparelho. O navegador só deixa
      // capturar a tela pelo diálogo do sistema (getDisplayMedia): no Android
      // ele abre na hora; no iPhone (iOS 15+) é preciso iniciar a transmissão
      // pelo Centro de Controle — por isso damos a instrução antes de chamar.
      const hasDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      if (!hasDisplayMedia) {
        toast.error(
          isIOS
            ? 'Este iPhone não expõe captura de tela. Use o Safari mais recente ou atualize o iOS.'
            : 'Compartilhamento de tela não é suportado neste navegador.'
        )
        return
      }
      if (isIOS) {
        toast.info(
          'iPhone: abra o Centro de Controle e toque em "Transmissão de tela" para começar a compartilhar.'
        )
      }
      // Áudio da tela: sem cancelamento de eco/supressão (que abafam o som da
      // tela). O Chrome só entrega áudio quando a fonte tem som próprio — isso
      // acontece ao compartilhar uma ABA marcando "incluir áudio da guia".
      const screenAudioConstraints = screenWithAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: screenAudioConstraints,
      })
      screenStreamRef.current = stream
      // Pedimos o áudio mas a fonte escolhida não trouxe som (janela/tela cheia
      // não têm áudio; só aba com "incluir áudio da guia"). Orienta o usuário.
      if (screenWithAudio && stream.getAudioTracks().length === 0) {
        toast.info(
          'Sem áudio na tela: o som só sai ao compartilhar uma ABA e marcar "incluir áudio da guia". Janela e tela cheia não têm som.'
        )
      }
      // Aplica o mudo do áudio da tela (alto-falante ao lado de "Compartilhar").
      if (screenAudioMuted) stream.getAudioTracks().forEach((t) => (t.enabled = false))
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
  }, [applyQualityToStreams, quality, broadcastScreenKind, screenWithAudio, screenAudioMuted])

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
  }, [t])

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
  const tiles = useMemo<Tile[]>(() => {
  const tiles: Tile[] = []
  if (inCall) {
    const localStream = localMediaStream
    if (camOn && localStream) {
      tiles.push({
        id: 'local-cam',
        name: `${name} (Você)`,
        photo: profile.photo,
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
        photo: profile.photo,
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
        photo: profile.photo,
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
      // Nome/foto reais do participante (a lista onlineMembers está sempre atualizada),
      // evitando o nome provisório "Usuário" quando o vídeo chega antes do nome.
      const member = onlineMembers.find((m) => m.clientId === peerId)
      const peerName = member?.name || peer.name || 'Usuário'
      const peerPhoto = member?.photo || peer.photo
      peer.streams.forEach((stream) => {
        const hasVideo = stream.getVideoTracks().length > 0
        const videoId = stream.getVideoTracks()[0]?.id ?? ''
        tiles.push({
          id: `remote-${peerId}-${stream.id}`,
          name: peerName,
          photo: peerPhoto,
          stream,
          hasVideo,
          isLocal: false,
          peerId,
          muted: mutedPeers[peerId] ?? false,
          isScreen: hasVideo && screenIds.includes(videoId),
        })
      })
      // Ainda sem mídia (áudio/vídeo não chegou): mostra o card de voz na hora,
      // para o participante nunca ficar invisível. Vira mic/vídeo quando chega.
      if (peer.streams.length === 0) {
        tiles.push({
          id: `remote-${peerId}-voice`,
          name: peerName,
          photo: peerPhoto,
          stream: null,
          hasVideo: false,
          isLocal: false,
          peerId,
          muted: mutedPeers[peerId] ?? false,
          isScreen: false,
        })
      }
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
    return tiles
  }, [inCall, camOn, name, profile, screenStreaming, remotePeers, mutedPeers, isAdmin, demoScreens, localMediaStream, onlineMembers])

  // Ordena as telas compartilhadas por ordem de ativação (quem começou primeiro).
  const allScreenTiles = tiles.filter((t) => t.isScreen)
  screenOrderRef.current = allScreenTiles
    .map((t) => t.id)
    .filter((id) => screenOrderRef.current.includes(id))
    .concat(allScreenTiles.map((t) => t.id).filter((id) => !screenOrderRef.current.includes(id)))
  const screenTiles = [...allScreenTiles].sort(
    (a, b) => screenOrderRef.current.indexOf(a.id) - screenOrderRef.current.indexOf(b.id)
  )
  // Aba "Perfis": UM card por participante (perfis), sempre visíveis,
  // mesmo que a pessoa tenha a câmera ou a tela ligada (ela aparece também
  // nas abas Câmeras/Telas, sem sair daqui).
  const profileTiles = useMemo<Tile[]>(() => {
    if (!inCall) return []
    const list: Tile[] = []
    list.push({
      id: 'local-profile',
      name: `${name} (Você)`,
      photo: profile.photo,
      stream: localMediaStream,
      hasVideo: false,
      isLocal: true,
      peerId: null,
      muted: false,
    })
    for (const [pid, peer] of Object.entries(remotePeers)) {
      const member = onlineMembers.find((m) => m.clientId === pid)
      const pname = member?.name || peer.name || 'Usuário'
      const pphoto = member?.photo || peer.photo
      const screenIds = screenTrackIdsRef.current[pid] ?? []
      const audioStream = peer.streams.find((s) => {
        const vid = s.getVideoTracks()[0]?.id ?? ''
        return !screenIds.includes(vid)
      })
      list.push({
        id: `profile-${pid}`,
        name: pname,
        photo: pphoto,
        stream: audioStream ?? null,
        hasVideo: false,
        isLocal: false,
        peerId: pid,
        muted: mutedPeers[pid] ?? false,
      })
    }
    return list
  }, [inCall, name, profile, remotePeers, onlineMembers, mutedPeers, localMediaStream])
  const extraScreens = screenTiles.slice(2)
  // Áudio de voz de cada participante remoto (o stream de câmera/microfone, não
  // a tela). É montado de forma FIXA em qualquer aba para que o som continue
  // saindo mesmo quando o usuário está vendo "Câmeras" ou "Telas" (que só
  // renderizam vídeos e por isso desmontavam o áudio de quem é só-voz).
  const remoteVoice = useMemo(() => {
    if (!inCall) return []
    const list: { id: string; peerId: string; stream: MediaStream; muted: boolean }[] = []
    for (const [pid, peer] of Object.entries(remotePeers)) {
      const screenIds = screenTrackIdsRef.current[pid] ?? []
      const voice = peer.streams.find((s) => {
        const vid = s.getVideoTracks()[0]?.id ?? ''
        return !screenIds.includes(vid)
      })
      if (!voice) continue
      list.push({ id: `voice-${pid}`, peerId: pid, stream: voice, muted: mutedPeers[pid] ?? false })
    }
    return list
  }, [inCall, remotePeers, mutedPeers])
  // Câmeras ativas (inclui a minha) e se há telas/câmeras para exibir nas abas.
  const cameraTiles = tiles.filter((t) => !t.isScreen && t.hasVideo)
  const hasCameras = cameraTiles.length > 0
  const hasScreens = screenTiles.length > 0

  // Se a aba aberta ficou vazia (ex.: todos desligaram a câmera), volta para perfis.
  useEffect(() => {
    if (callView === 'cameras' && !hasCameras) setCallView('profiles')
    if (callView === 'screens' && !hasScreens) setCallView('profiles')
  }, [callView, hasCameras, hasScreens])

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
      className={`relative overflow-hidden rounded-xl transition-shadow duration-200 ${
        tile.hasVideo
          ? speakers[tile.stream ? tile.stream.id : '']
            ? 'border border-emerald-400 ring-2 ring-emerald-400/40 shadow-[0_0_20px_rgba(16,185,129,0.4)]'
            : 'border border-white/10 bg-black/60'
          : 'bg-transparent'
      } ${
        tile.isScreen
          ? 'aspect-video w-[420px] max-w-full sm:w-[520px] lg:w-[720px]'
          : tile.hasVideo
            ? 'aspect-video w-[300px] max-w-[80%] sm:w-[340px] lg:w-[400px]'
            : 'w-24 sm:w-28'
      }`}
    >
      {tile.hasVideo ? (
        <video
          autoPlay
          playsInline
          // Som de câmera remota vem do bloco de áudio fixo (remoteVoice);
          // aqui muto o vídeo para não duplicar. Telas compartilhadas seguem
          // com o próprio som (screenMuted).
          muted={tile.isLocal || (tile.isScreen ? !!screenMuted[tile.id] : true)}
          // Filtro de cor/contraste só quando o usuário ligar "Cores vívidas" nas
          // configurações. Filtro em <video> força o processador gráfico a recompor
          // todo quadro e esquenta no celular; por isso fica desligado por padrão.
          style={{ filter: settings.videoVivid ? 'contrast(1.08) saturate(1.14) brightness(1.03)' : 'none' }}
          className="h-full w-full object-cover"
          ref={(el) => bind(el, tile.stream)}
        />
      ) : (
        <>
          {/* O áudio dos participantes só-voz é tocado pelo bloco fixo no topo
              de "renderMain", que fica montado em qualquer aba (ver remoteVoice). */}
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1">
            <div className="relative">
              <div
                className={`flex h-12 w-12 items-center justify-center overflow-hidden rounded-full transition-shadow duration-150 ${
                  speakers[tile.stream ? tile.stream.id : ''] ? 'ring-2 ring-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.55)]' : ''
                }`}
              >
                <Avatar name={tile.name} photo={tile.photo} size={48} />
              </div>
              {speakers[tile.stream ? tile.stream.id : ''] && (
                <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-emerald-400" />
              )}
              {(tile.isLocal ? !micOn : tile.muted) && (
                <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-500/90 text-xs text-white">🔇</span>
              )}
            </div>
            <span className="max-w-full truncate px-1 text-[11px] font-medium text-slate-100">
              {tile.name}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> ao vivo
            </span>
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
          {/* Virar câmera — sempre visível na câmera local, à esquerda do esticar */}
          {tile.isLocal && !tile.isScreen && camOn && isMobileDevice && (
            <button
              title={t('cameraFlip')}
              onClick={flipCamera}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-sm transition hover:bg-black/70"
            >
              🔄
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
          const key = tile.stream ? tile.stream.id : tile.id
          if (next[key]) {
            delete next[key]
            changed = true
          }
          return
        }
        // Chaveamos por stream.id (e não tile.id): o card de "Perfis" e o tile
        // principal da MESMA pessoa usam o MESMO stream de voz, então o anel
        // verde acende na borda do avatar do perfil também — e não só no vídeo.
        const key = tile.stream.id
        const analyser = analysersRef.current.get(key)
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
        if (!!next[key] !== speaking) {
          next[key] = speaking
          changed = true
        }
      })
      if (changed) {
        speakersRef.current = next
        setSpeakers(next)
      }
    }, 230)
    return () => window.clearInterval(timer)
  }, [tiles, micOn, mutedPeers])

  // Tile compacto para as abas "Câmeras" e "Ver tela": vídeo + perfil na quina.
  const renderMediaTile = (tile: Tile, square: boolean) => {
    return (
      <div
        key={tile.id}
        ref={(el) => {
          tileElsRef.current[tile.id] = el
        }}
        className={`relative flex-none overflow-hidden rounded-xl border border-white/10 bg-black/70 transition-shadow duration-200 ${
          speakers[tile.stream ? tile.stream.id : '']
            ? 'ring-2 ring-emerald-400/50 shadow-[0_0_18px_rgba(16,185,129,0.4)]'
            : ''
        } ${
          square
            ? 'aspect-square w-[150px] sm:w-[170px]'
            : 'aspect-video w-[250px] sm:w-[300px] lg:w-[380px]'
        }`}
      >
        {tile.hasVideo ? (
          <video
            autoPlay
            playsInline
            // Som de câmera remota vem do áudio fixo (remoteVoice). Telas
            // compartilhadas seguem com o próprio som (screenMuted).
            muted={tile.isLocal || (tile.isScreen ? !!screenMuted[tile.id] : true)}
            className={`h-full w-full ${tile.isScreen ? 'object-contain' : 'object-cover'}`}
            ref={(el) => bind(el, tile.stream)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl">🖥️</div>
        )}
        {/* Perfil (foto + nome) no canto inferior esquerdo */}
        <div className="absolute bottom-2 left-2 flex max-w-[80%] items-center gap-1.5 rounded-lg bg-black/65 px-2 py-1">
          <span className="relative flex">
            <Avatar
              name={tile.name}
              photo={tile.photo}
              size={22}
              className={speakers[tile.stream ? tile.stream.id : ''] ? 'ring-2 ring-emerald-400' : ''}
            />
            {speakers[tile.stream ? tile.stream.id : ''] && (
              <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-emerald-400 ring-2 ring-emerald-300/80" />
            )}
          </span>
          <span className="truncate text-[11px] font-semibold text-slate-100">{tile.name}</span>
          {speakers[tile.stream ? tile.stream.id : ''] && (
            <span className="text-[10px] leading-none text-emerald-300" aria-label="falando">🔊</span>
          )}
        </div>
        {/* Controles: mudo (telas remotas) + expandir/tela cheia */}
        <div className="absolute right-2 top-2 flex gap-1.5">
          {tile.isScreen && !tile.isLocal && (
            <button
              title={screenMuted[tile.id] ? t('screenUnmute') : t('screenMute')}
              onClick={() => setScreenMuted((prev) => ({ ...prev, [tile.id]: !(prev[tile.id] ?? false) }))}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-sm text-white transition hover:bg-black/70"
            >
              {screenMuted[tile.id] ? '🔇' : '🔊'}
            </button>
          )}
          {/* Virar câmera — aparece só para o dono da câmera (frontal/traseira) */}
          {tile.isLocal && !tile.isScreen && camOn && isMobileDevice && (
            <button
              title={t('cameraFlip')}
              onClick={flipCamera}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-sm text-white transition hover:bg-black/70"
            >
              🔄
            </button>
          )}
          <button
            title="Expandir (tela cheia)"
            onClick={() => toggleTileFullscreen(tile.id)}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-sm text-white transition hover:bg-black/70"
          >
            ⛶
          </button>
          {/* Fixar câmera — lado a lado na tela cheia (até 3). Só no computador,
              nas câmeras dos outros participantes (a sua entra automática como
              a principal, nº 1). */}
          {pinnable(tile) && (
            <button
              title={
                pinnedIds.includes(pinKeyOf(tile) ?? '')
                  ? 'Remover da fixação'
                  : 'Fixar câmera (mostra até 3 lado a lado na tela cheia)'
              }
              onClick={() => togglePin(tile)}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm text-white transition ${
                pinnedIds.includes(pinKeyOf(tile) ?? '')
                  ? 'bg-emerald-500/90 hover:bg-emerald-500'
                  : 'bg-black/50 hover:bg-black/70'
              }`}
            >
              📌
            </button>
          )}
        </div>
      </div>
    )
  }

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
        {/* Áudio fixo de todos os participantes: fica montado em qualquer aba para
            o som nunca cortar (mesmo em Câmeras/Telas que só mostram vídeos). */}
        {remoteVoice.map((v) => (
          <audio
            key={v.id}
            autoPlay
            playsInline
            muted={v.muted}
            className="hidden"
            ref={(el) => bind(el, v.stream)}
          />
        ))}
        {/* Aba de CÂMERAS */}
        {callView === 'cameras' && (
          <>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-200 ring-1 ring-sky-400/20">
              <span className="font-semibold">📷 {t('camerasTabTitle')} ({cameraTiles.length})</span>
            </div>
            <div className="flex flex-wrap content-start items-start justify-start gap-3">
              {cameraTiles.map((tile) => renderMediaTile(tile, true))}
            </div>
          </>
        )}
        {/* Aba de TELAS COMPARTILHADAS */}
        {callView === 'screens' && (
          <>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-200 ring-1 ring-fuchsia-400/20">
              <span className="font-semibold">🖥️ {t('screensTabTitle')} ({screenTiles.length})</span>
            </div>
            <div className="flex flex-wrap content-start items-start justify-start gap-3">
              {screenTiles.map((tile) => renderMediaTile(tile, false))}
            </div>
          </>
        )}
        {/* Aba de PERFIS (padrão): somente os perfis dos participantes */}
        {callView === 'profiles' && (
          <div className="flex min-h-0 flex-wrap content-start items-start justify-start gap-3">
            {profileTiles.map((tile) => renderTile(tile))}
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

      {/* Avisos de convite de sala — cards pequenos centralizados no topo */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[9999] flex flex-col items-center gap-2 px-4">
        {inviteAlerts.map((alert) => (
          <InviteAlert
            key={alert.id}
            fromName={alert.fromName}
            fromPhoto={alert.fromPhoto}
            roomName={alert.roomName}
            onGo={() => {
              closeInviteAlert(alert.id)
              openInvitesTab()
            }}
            dismiss={() => closeInviteAlert(alert.id)}
          />
        ))}
      </div>

      {/* Sidebar */}
      <aside
        className={`share-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl p-3 lg:col-start-1 lg:row-start-1 lg:overflow-y-auto ${
          mobileTab === 'inicio' ? 'flex' : 'hidden'
        } ${inicioView === 'home' ? 'lg:row-span-2' : ''} lg:flex`}
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
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
                  {/* Canais fixos à esquerda */}
                  <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl bg-white/5 p-1.5">
                    <p className="px-1 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      Canais
                    </p>
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
                          className={`mb-1 flex items-center gap-1.5 rounded-lg px-2 py-2 text-left text-xs transition ${
                            active
                              ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/40'
                              : 'text-slate-300 hover:bg-white/5'
                          }`}
                        >
                          <span>{active ? '🔊' : '🔈'}</span>
                          <span className="flex-1 truncate font-semibold">{c.label}</span>
                          <span
                            title={`${count}/10 online`}
                            className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold tabular-nums ring-1 ${
                              count >= 10
                                ? 'bg-rose-500/15 text-rose-300 ring-rose-400/30'
                                : 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
                            }`}
                          >
                            {count}/10
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {/* Salas públicas criadas à direita */}
                  <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl bg-white/5 p-1.5">
                    <p className="px-1 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      Salas
                    </p>
                    {rooms.length === 0 ? (
                      <p className="px-1 py-2 text-center text-[11px] leading-snug text-slate-500">
                        Nenhuma sala ainda. Crie uma na aba ➕.
                      </p>
                    ) : (
                      rooms.map((room) => {
                        const active = inCall && channel === room.id
                        const cap = room.capacity > 0 ? room.capacity : 10
                        const count = Math.min(
                          onlineMembers.filter((m) => m.channel === room.id).length,
                          cap
                        )
                        return (
                          <button
                            key={room.id}
                            onClick={() => void openRoom(room)}
                            className={`mb-1 rounded-lg px-2 py-2 text-left text-xs transition ${
                              active
                                ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/40'
                                : 'text-slate-300 hover:bg-white/5'
                            }`}
                          >
                            <span className="flex items-center gap-1.5">
                              <span>🌐</span>
                              <span className="flex-1 truncate font-semibold">{room.name}</span>
                            </span>
                            <span className="mt-0.5 flex items-center justify-between gap-1">
                              <span className="flex min-w-0 items-center gap-1 truncate text-[10px] text-slate-400">
                                {room.ownerPhoto && (
                                  <img
                                    src={room.ownerPhoto}
                                    alt=""
                                    className="h-3.5 w-3.5 shrink-0 rounded-full object-cover"
                                  />
                                )}
                                <span className="truncate">{room.ownerName ?? 'Usuário'}</span>
                              </span>
                              <span
                                title={`${count}/${cap} online`}
                                className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold tabular-nums ring-1 ${
                                  count >= cap
                                    ? 'bg-rose-500/15 text-rose-300 ring-rose-400/30'
                                    : 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
                                }`}
                              >
                                {count}/{cap}
                              </span>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            ) : inicioView === 'criar' ? (
              <div className="mt-3 flex min-h-0 flex-1 flex-col">
                {!authUser ? (
                  <div className="flex flex-1 flex-col items-center justify-center text-center">
                    <span className="text-4xl">🔒</span>
                    <p className="mt-3 max-w-[16rem] text-sm text-slate-400">
                      Faça login com o Google para criar suas próprias salas.
                    </p>
                    <a
                      href="/login"
                      className="mt-4 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:bg-indigo-400"
                    >
                      Entrar com o Google
                    </a>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
                    <p className="mb-2 text-center text-xs font-medium text-slate-400">
                      Dê um nome para sua sala
                    </p>
                    <input
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      maxLength={30}
                      placeholder="Ex.: Festa da galera"
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-500/20"
                    />
                    <button
                      onClick={() => setNewRoomPrivate((v) => !v)}
                      className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/10"
                    >
                      <span>
                        <span className="block text-sm font-semibold">
                          {newRoomPrivate ? 'Privada 🔒' : 'Pública 🌐'}
                        </span>
                        <span className="block text-xs text-slate-400">
                          {newRoomPrivate
                            ? 'Só você pode entrar'
                            : 'Qualquer pessoa pode entrar'}
                        </span>
                      </span>
                      <span className="text-lg">{newRoomPrivate ? '🔒' : '🌐'}</span>
                    </button>
                    {newRoomPrivate && (
                      <>
                        <input
                          value={newRoomPassword}
                          onChange={(e) => setNewRoomPassword(e.target.value)}
                          maxLength={20}
                          type="password"
                          autoComplete="off"
                          name="roomPassword"
                          placeholder="Senha (opcional)"
                          className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-amber-400/60 focus:ring-2 focus:ring-amber-500/20"
                        />
                        <p className="mt-1 text-[11px] text-slate-400">
                          🔑 Deixe em branco para entrar sem senha. Com senha, só convidados ou
                          quem souber a senha entram.
                        </p>
                      </>
                    )}
                    <div className="mt-3">
                      <p className="mb-1.5 text-xs font-semibold text-slate-300">Capacidade</p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[4, 8, 16].map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setNewRoomCapacity(c)}
                            className={`rounded-xl border px-2 py-2.5 text-sm font-semibold transition ${
                              newRoomCapacity === c
                                ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                                : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                            }`}
                          >
                            {c} pessoas
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => void createRoom()}
                      disabled={creatingRoom || !newRoomName.trim()}
                      className="mt-3 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:opacity-40"
                    >
                      {creatingRoom ? 'Criando...' : 'Criar sala'}
                    </button>
                  </div>
                )}
              </div>
            ) : inicioView === 'privadas' ? (
              <div className="mt-3 flex min-h-0 flex-1 flex-col">
                <p className="mb-2 text-center text-xs font-medium text-slate-400">
                  Salas privadas com pessoas dentro agora. Para entrar, você precisa ser convidado.
                </p>
                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                  {!authUser ? (
                    <div className="flex flex-1 flex-col items-center justify-center text-center">
                      <span className="text-4xl">🔒</span>
                      <p className="mt-3 text-sm text-slate-400">
                        Faça login com o Google para ver as salas privadas.
                      </p>
                    </div>
                  ) : privateRooms.length === 0 ? (
                    <div className="flex flex-col items-center justify-center pt-10 text-center">
                      <span className="text-4xl">📁</span>
                      <p className="mt-3 text-sm text-slate-400">
                        Nenhuma sala privada ocupada no momento.
                      </p>
                      <button
                        onClick={() => setInicioView('criar')}
                        className="mt-3 rounded-lg bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
                      >
                        Criar sala
                      </button>
                    </div>
                  ) : (
                    privateRooms
                      .map((room) => {
                        const active = inCall && channel === room.id
                        const cap = room.capacity > 0 ? room.capacity : 10
                        const count = Math.min(
                          onlineMembers.filter((m) => m.channel === room.id).length,
                          cap
                        )
                        return (
                          <div
                            key={room.id}
                            className={`flex items-center gap-2 rounded-lg px-3 py-2 transition ${
                              active
                                ? 'bg-indigo-500/20 ring-1 ring-indigo-400/40'
                                : 'bg-white/5 hover:bg-white/10'
                            }`}
                          >
                            <span className="text-base">🔒</span>
                            <button
                              onClick={() => void openRoom(room)}
                              className="flex-1 truncate text-left"
                            >
                              <span className="block truncate text-sm font-semibold text-slate-200">
                                {room.name}
                              </span>
                              <span className="block text-[10px] text-slate-400">
                                {room.hasPassword ? '🔑 Senha necessária' : 'Sem senha'} · {count}/{cap}
                              </span>
                            </button>
                            <span
                              className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-emerald-300 ring-1 ring-emerald-400/30"
                            >
                              OK
                            </span>
                          </div>
                        )
                      })
                  )}
                </div>
              </div>
            ) : inicioView === 'minhas' ? (
              <div className="mt-3 flex min-h-0 flex-1 flex-col">
                <p className="mb-2 text-center text-xs font-medium text-slate-400">
                  Suas salas, com convite e gerenciamento.
                </p>
                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                  {!authUser ? (
                    <div className="flex flex-1 flex-col items-center justify-center text-center">
                      <span className="text-4xl">🔒</span>
                      <p className="mt-3 text-sm text-slate-400">
                        Faça login com o Google para ver suas salas.
                      </p>
                    </div>
                  ) : myRooms.length === 0 ? (
                    <div className="flex flex-col items-center justify-center pt-10 text-center">
                      <span className="text-4xl">📁</span>
                      <p className="mt-3 text-sm text-slate-400">
                        Você ainda não criou nenhuma sala.
                      </p>
                      <button
                        onClick={() => setInicioView('criar')}
                        className="mt-3 rounded-lg bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
                      >
                        Criar sala
                      </button>
                    </div>
                  ) : (
                    myRooms.map((room) => {
                      const active = inCall && channel === room.id
                      const cap = room.capacity > 0 ? room.capacity : 10
                      const count = Math.min(
                        onlineMembers.filter((m) => m.channel === room.id).length,
                        cap
                      )
                      return (
                        <div
                          key={room.id}
                          className={`flex items-center gap-2 rounded-lg px-3 py-2 transition ${
                            active
                              ? 'bg-indigo-500/20 ring-1 ring-indigo-400/40'
                              : 'bg-white/5 hover:bg-white/10'
                          }`}
                        >
                          <span className="text-base">{room.isPrivate ? '🔒' : '🌐'}</span>
                          <button
                            onClick={() => void openRoom(room)}
                            className="flex-1 truncate text-left"
                          >
                            <span className="block truncate text-sm font-semibold text-slate-200">
                              {room.name}
                            </span>
                            <span className="block text-[10px] text-slate-400">
                              {room.isPrivate ? 'Privada' : 'Pública'} · {count}/{cap}
                            </span>
                          </button>
                          <button
                            onClick={() => void openInvite(room)}
                            aria-label="Convidar amigos"
                            title="Convidar amigos para esta sala"
                            className="shrink-0 rounded-md bg-indigo-500/20 px-2 py-1 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/30"
                          >
                            📨 Convidar
                          </button>
                          <button
                            onClick={() => startEditRoom(room)}
                            aria-label="Editar sala"
                            title="Editar nome, privacidade e senha da sala"
                            className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-amber-200 transition hover:bg-amber-500/20"
                          >
                            ✏️ Editar
                          </button>
                          <button
                            onClick={() => {
                              if (window.confirm(`Excluir a sala "${room.name}"?`)) {
                                void deleteRoom(room.id)
                              }
                            }}
                            aria-label="Excluir sala"
                            className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-xs text-rose-300 transition hover:bg-rose-500/20"
                          >
                            🗑
                          </button>
                        </div>
                      )
                    })
                  )}
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
              {/* Fileira principal: ações essenciais em círculos.
                  As abas "Ver câmeras"/"Ver telas" ficam numa fileira ACIMA,
                  cada uma alinhada sobre o seu ícone (câmera ou tela). */}
              <div className="flex flex-col items-center gap-1">
                {/* Fileira de abas (acima dos ícones) */}
                <div className="flex items-end justify-center gap-x-4">
                  <span className="w-20 flex-none" />
                  <div className="flex h-7 w-20 flex-none items-center justify-center">
                    {hasCameras ? (
                      <button
                        onClick={() => setCallView(callView === 'cameras' ? 'profiles' : 'cameras')}
                        title={t('camerasTabTitle')}
                        className={`flex h-7 max-w-full items-center justify-center rounded-full px-2.5 text-[10px] font-semibold leading-tight transition ${
                          callView === 'cameras'
                            ? 'bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/50'
                            : 'bg-white/10 text-white hover:bg-white/15'
                        }`}
                      >
                        {callView === 'cameras' ? t('backToProfiles') : t('seeCamerasBtn')}
                      </button>
                    ) : (
                      <span className="h-7 flex-none" />
                    )}
                  </div>
                  <div className="flex h-7 w-20 flex-none items-center justify-center">
                    {hasScreens ? (
                      <button
                        onClick={() => setCallView(callView === 'screens' ? 'profiles' : 'screens')}
                        title={t('screensTabTitle')}
                        className={`flex h-7 max-w-full items-center justify-center rounded-full px-2.5 text-[10px] font-semibold leading-tight transition ${
                          callView === 'screens'
                            ? 'bg-fuchsia-500/25 text-fuchsia-100 ring-1 ring-fuchsia-400/50'
                            : 'bg-white/10 text-white hover:bg-white/15'
                        }`}
                      >
                        {callView === 'screens' ? t('backToProfiles') : t('seeScreensBtn')}
                      </button>
                    ) : (
                      <span className="h-7 flex-none" />
                    )}
                  </div>
                </div>
                {/* Fileira de ícones (embaixo) */}
                <div className="flex items-center justify-center gap-x-4">
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
                  onClick={() => {
                    if (screenStreaming) {
                      // Já compartilhando: o alto-falante muta/desmuta o som da tela
                      // para todos ao vivo (silencia a trilha de áudio da tela).
                      const next = !screenAudioMuted
                      setScreenAudioMuted(next)
                      screenStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next))
                    } else {
                      // Antes de compartilhar: escolhe se quer capturar o som.
                      setScreenWithAudio((o) => !o)
                    }
                  }}
                  title={screenStreaming ? (screenAudioMuted ? t('screenUnmute') : t('screenMute')) : t('screenAudio')}
                  className={`flex h-8 min-w-28 items-center justify-center gap-1 rounded-full px-3 text-[11px] font-semibold transition ${
                    screenStreaming
                      ? screenAudioMuted
                        ? 'bg-white/10 text-slate-300'
                        : 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/30'
                      : screenWithAudio
                        ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/30'
                        : 'bg-white/10 text-slate-300 hover:bg-white/15'
                  }`}
                >
                  {screenStreaming
                    ? screenAudioMuted
                      ? `🔇 ${t('screenMute')}`
                      : `🔊 ${t('screenAudio')}`
                    : screenWithAudio
                      ? `🔊 ${t('screenAudio')}`
                      : `🔇 ${t('screenNoAudio')}`}
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
        } ${inicioView === 'home' ? 'lg:hidden' : 'lg:flex'}`}
      >
        {!inCall ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <div className="text-5xl">💬</div>
            <h2 className="mt-4 text-xl font-bold">{t('chatTitle')}</h2>
            <p className="mt-2 max-w-md text-sm text-slate-400">{t('locked')}</p>
          </div>
        ) : (
          <>
            <h3 className="text-sm font-semibold">{t('chatTitle')} · {roomLabelsRef.current[channel] ?? channelLabel(channel)}</h3>
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
                className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-800/60 px-3 text-base outline-none focus:border-indigo-400/50"
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
        <div className="share-panel share-panel-flat settings-drawer fixed inset-0 z-40 flex flex-col overflow-hidden lg:inset-y-6 lg:left-1/2 lg:h-[88vh] lg:w-full lg:max-w-5xl lg:-translate-x-1/2 lg:flex-row lg:rounded-2xl lg:p-0">
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
                {({ menu: t('configTitle'), conta: t('account'), privacidade: t('privacy'), perfil: t('profile'), avancado: t('advanced'), audio: t('audioVideo'), aparencia: t('appearance'), notificacoes: t('notifications'), silencioso: t('silentMode'), idioma: t('language'), limpeza: t('cleanup'), sobre: t('about'), atualizacoes: t('atualizacoes'), online: t('onlinePeople'), amigos: t('amigos') } as Record<string, string>)[configPane]}
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
            className={`flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto no-scrollbar p-4 pb-28 lg:hidden ${
              configPane === 'menu' ? '' : 'hidden'
            }`}
          >
            {(
              [
                {
                  title: '👤 Conta & Amigos',
                  items: [
                    ['conta', '🔑', 'bg-indigo-500/20', t('account'), t('accountDesc')],
                    ['perfil', '👤', 'bg-indigo-500/20', t('profile'), t('perfilDesc')],
                    ['amigos', '🤝', 'bg-emerald-500/15', t('amigos'), t('amigosDesc')],
                    ['online', '👥', 'bg-emerald-500/15', t('onlinePeople'), t('onlinePeopleDesc')],
                    ['privacidade', '🔒', 'bg-rose-500/15', t('privacy'), t('privacidadeDesc')],
                  ],
                },
                {
                  title: '🎙️ Áudio & Vídeo',
                  items: [
                    ['audio', '🎙️', 'bg-sky-500/15', t('audioVideo'), t('audioDesc')],
                  ],
                },
                {
                  title: '🎨 Aparência & Comportamento',
                  items: [
                    ['aparencia', '🎨', 'bg-fuchsia-500/15', t('appearance'), t('aparenciaDesc')],
                    ['idioma', '🌐', 'bg-emerald-500/15', t('language'), t('idiomaDesc')],
                    ['notificacoes', '🔔', 'bg-amber-500/15', t('notifications'), t('notificacoesDesc')],
                    ['silencioso', '🤫', 'bg-slate-500/15', t('silentMode'), t('silenciosoDesc')],
                  ],
                },
                {
                  title: '⚙️ Sistema',
                  items: [
                    ['limpeza', '🧹', 'bg-red-500/15', t('cleanup'), t('limpezaDesc')],
                    ['avancado', '🛠️', 'bg-emerald-500/15', t('advanced'), t('avancadoDesc')],
                    ['atualizacoes', '🚀', 'bg-sky-500/15', t('atualizacoes'), t('atualizacoesDesc')],
                    ['sobre', 'ℹ️', 'bg-cyan-500/15', t('about'), t('sobreDesc')],
                  ],
                },
              ] as const
            ).map((group) => (
              <div key={group.title} className="flex flex-col gap-2">
                <div className="mt-1 px-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  {group.title}
                </div>
                {group.items
                  .filter(([id]) => isAdmin || id !== 'limpeza')
                  .map(([id, icon, bg, label, desc]) => (
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
                      <span className="block text-xs text-slate-200">{desc}</span>
                    </span>
                    {id === 'amigos' && pendingCount > 0 && (
                      <span className="absolute right-3 top-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white shadow-lg shadow-rose-500/40">
                        {pendingCount > 9 ? '+9' : pendingCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Menu lateral — desktop (sempre visível) */}
          <div className="hidden flex-col gap-1 overflow-y-auto no-scrollbar p-3 lg:flex lg:w-72 lg:shrink-0 lg:border-r lg:border-white/10">
            <div className="mb-1 px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              ⚙️ {t('configTitle')}
            </div>
            {(
              [
                {
                  title: '👤 Conta & Amigos',
                  items: [
                    ['conta', '🔑', t('account')],
                    ['perfil', '👤', t('profile')],
                    ['amigos', '🤝', t('amigos')],
                    ['online', '👥', t('onlinePeople')],
                    ['privacidade', '🔒', t('privacy')],
                  ],
                },
                {
                  title: '🎙️ Áudio & Vídeo',
                  items: [['audio', '🎙️', t('audioVideo')]],
                },
                {
                  title: '🎨 Aparência & Comportamento',
                  items: [
                    ['aparencia', '🎨', t('appearance')],
                    ['idioma', '🌐', t('language')],
                    ['notificacoes', '🔔', t('notifications')],
                    ['silencioso', '🤫', t('silentMode')],
                  ],
                },
                {
                  title: '⚙️ Sistema',
                  items: [
                    ['limpeza', '🧹', t('cleanup')],
                    ['avancado', '🛠️', t('advanced')],
                    ['atualizacoes', '🚀', t('atualizacoes')],
                    ['sobre', 'ℹ️', t('about')],
                  ],
                },
              ] as const
            ).map((group) => (
              <div key={group.title} className="flex flex-col gap-1">
                <div className="mb-0.5 px-2 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {group.title}
                </div>
                {group.items
                  .filter(([id]) => isAdmin || id !== 'limpeza')
                  .map(([id, icon, label]) => (
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
            ))}
          </div>

          {/* Conteúdo da categoria selecionada */}
          <div
            className={`min-h-0 flex-1 flex-col overflow-y-auto no-scrollbar ${
              configPane === 'menu' ? 'hidden lg:flex' : 'mt-4 flex lg:mt-0'
            }`}
          >
            {/* Cabeçalho desktop */}
            <div className="hidden items-center justify-between border-b border-white/10 px-5 py-3 lg:flex">
              <h3 className="text-base font-bold">
                {({ conta: t('account'), privacidade: t('privacy'), perfil: t('profile'), avancado: t('advanced'), audio: t('audioVideo'), aparencia: t('appearance'), notificacoes: t('notifications'), silencioso: t('silentMode'), idioma: t('language'), limpeza: t('cleanup'), sobre: t('about'), atualizacoes: t('atualizacoes'), online: t('onlinePeople'), amigos: t('amigos'), menu: t('configTitle') } as Record<string, string>)[configPane]}
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
            <div className="flex flex-col gap-3 pb-28 lg:p-5">
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
                      setConfigOpen(false)
                      setMobileTab('inicio')
                    }}
                    className="w-full rounded-xl bg-indigo-500/20 px-4 py-3 text-left text-sm font-semibold text-indigo-200 ring-1 ring-indigo-400/30 transition hover:bg-indigo-500/30"
                  >
                    ✏️ {t('editProfile')}
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
                    roomNameOf={(id) => roomLabelsRef.current[id] ?? channelLabel(id)}
                    onOpenProfile={(p) =>
                      setViewProfile({ userId: p.userId, name: p.name, photo: p.photo ?? undefined, bio: p.bio ?? undefined, cover: p.cover ?? undefined })
                    }
                  />
                </section>
              )}

              {/* Amigos: convites, código e lista */}
              {configPane === 'amigos' && (
                authUser ? (
                  <>
                    <section className="share-panel-soft flex flex-col gap-3 rounded-xl p-3">
                      <FriendsPanel
                        onOpenProfile={(p) =>
                          setViewProfile({ userId: p.userId, name: p.name, photo: p.photo ?? undefined, bio: p.bio ?? undefined, cover: p.cover ?? undefined })
                        }
                        roomInvites={roomInvites}
                        onJoinRoom={(roomId) => {
                          // Ao entrar na sala, fecha o painel de Configurações/Convites
                          // para não ficar sobreposto à tela de chamadas.
                          setConfigOpen(false)
                          setConfigPane('menu')
                          setMobileTab('chamadas')
                          void joinChannel(roomId).then(() => void loadRooms())
                        }}
                        onDeclineRoomInvite={(roomId) =>
                          void apiClient
                            .delete(`/api/rooms/invite?roomId=${encodeURIComponent(roomId)}`)
                            .then(() => void loadRooms())
                        }
                      />
                    </section>
                  </>
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

              {/* Privacidade */}
              {configPane === 'privacidade' && (
                <section className="share-panel-soft flex flex-col gap-4 rounded-xl p-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/15 text-xl">
                      🔒
                    </span>
                    <div>
                      <div className="text-sm font-semibold">{t('privacy')}</div>
                      <div className="text-xs text-slate-400">{t('privacidadeDesc')}</div>
                    </div>
                  </div>

                  {authUser ? (
                    privacyLoaded ? (
                      <>
                        <SwitchRow
                          checked={privacy.showOnline}
                          onChecked={(v) => setPrivacyFlag('showOnline', v)}
                          title={`🟢 ${t('privacyShowOnline')}`}
                          desc={`${t('privacyShowOnlineDesc')} · ${
                            privacy.showOnline ? t('privacyOn') : t('privacyOff')
                          }`}
                        />
                        <SwitchRow
                          checked={privacy.showLastseen}
                          onChecked={(v) => setPrivacyFlag('showLastseen', v)}
                          title={`🕒 ${t('privacyShowLastseen')}`}
                          desc={`${t('privacyShowLastseenDesc')} · ${
                            privacy.showLastseen ? t('privacyOn') : t('privacyOff')
                          }`}
                        />
                        <SwitchRow
                          checked={privacy.showRoom}
                          onChecked={(v) => setPrivacyFlag('showRoom', v)}
                          title={`📍 ${t('privacyShowRoom')}`}
                          desc={`${t('privacyShowRoomDesc')} · ${
                            privacy.showRoom ? t('privacyOn') : t('privacyOff')
                          }`}
                        />
                        <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-400">
                          💡 {settings.language === 'en'
                            ? 'Turn an option off to hide that info from your friends and your profile.'
                            : 'Desative uma opção para esconder essa informação dos seus amigos e do seu perfil.'}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-slate-400">Carregando...</p>
                    )
                  ) : (
                    <div className="flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center">
                      <div className="text-3xl">🔒</div>
                      <p className="text-xs text-slate-400">{t('privacyLocked')}</p>
                      <a
                        href="/login"
                        className="mt-1 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110"
                      >
                        <span className="text-lg leading-none">🌐</span> {t('signInGoogle')}
                      </a>
                    </div>
                  )}
                </section>
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

                {/* Sensibilidade do microfone (acessibilidade) */}
                <div className="mt-2 border-t border-white/5 pt-2">
                  <SwitchRow
                    checked={settings.micSensitivity}
                    onChecked={(v) => setSetting('micSensitivity', v)}
                    title={t('micSensitivity')}
                    desc={t('micSensitivityDesc')}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-400">{t('micVolume')}</span>
                    <span className="text-xs tabular-nums text-slate-300">
                      {Math.round(settings.micGain * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={200}
                    value={Math.round(settings.micGain * 100)}
                    onChange={(e) => setSetting('micGain', Number(e.target.value) / 100)}
                    className="w-full accent-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!settings.micSensitivity}
                    aria-label={t('micVolume')}
                  />
                </div>

                <p className="mt-2 text-[11px] leading-snug text-slate-300">{t('noiseEchoHint')}</p>
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

              {/* Câmera */}
              {configPane === 'audio' && (
              <section className="share-panel-soft mt-3 rounded-xl p-3">
                <h4 className="mb-2 text-sm font-bold">📷 {t('cameraLabel')}</h4>
                <SwitchRow
                  checked={settings.cameraEnhance}
                  onChecked={(v) => setSetting('cameraEnhance', v)}
                  title={t('cameraEnhance')}
                  desc={t('cameraEnhanceDesc')}
                />
                <div className="mt-2 border-t border-white/5 pt-2">
                  <SwitchRow
                    checked={settings.videoVivid}
                    onChecked={(v) => setSetting('videoVivid', v)}
                    title={t('videoVivid')}
                    desc={t('videoVividDesc')}
                  />
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">{t('videoVividHint')}</p>
                </div>
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
              {configPane === 'limpeza' && isAdmin && (
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
                  <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-200">v0.65</span>
                  <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">Ago 2026</span>
                </div>
                {t('aboutText')
                  .split('\n\n')
                  .map((block, i) => {
                    if (block.startsWith('#')) {
                      return (
                        <h5
                          key={i}
                          className="mb-1 mt-4 text-[12px] font-extrabold uppercase tracking-[0.14em] text-indigo-300"
                        >
                          {block.slice(1)}
                        </h5>
                      )
                    }
                    if (block.includes('•')) {
                      const items = block.split('\n').filter(Boolean)
                      return (
                        <ul key={i} className="mt-2 space-y-2">
                          {items.map((li) => (
                            <li
                              key={li}
                              className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-300"
                            >
                              <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-gradient-to-br from-indigo-400 to-cyan-400" />
                              <span>{li.replace(/^•\s*/, '')}</span>
                            </li>
                          ))}
                        </ul>
                      )
                    }
                    return (
                      <p
                        key={i}
                        className={`leading-relaxed text-slate-300 ${
                          i === 0
                            ? 'text-[15px] font-medium text-slate-200'
                            : 'text-sm'
                        }`}
                      >
                        {block}
                      </p>
                    )
                  })}
                <p className="mt-3 border-t border-white/10 pt-2 text-[11px] font-medium text-slate-400">
                  {t('aboutCredits')}
                </p>
              </section>
              )}

              {/* Atualizações */}
              {configPane === 'atualizacoes' && (
                <section className="flex flex-col gap-3">
                  <div className="share-panel-soft flex items-center gap-3 rounded-xl p-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/25 to-cyan-500/20 text-xl">
                      🚀
                    </span>
                    <div>
                      <h4 className="text-sm font-extrabold tracking-tight">
                        {settings.language === 'en' ? 'Orbit Room updates' : 'Atualizações do Orbit Room'}
                      </h4>
                      <p className="text-xs text-slate-400">
                        {settings.language === 'en'
                          ? 'A quick summary of what changed in each version.'
                          : 'Um resumo rápido do que mudou em cada versão.'}
                      </p>
                    </div>
                  </div>

                  {CHANGELOG.map((v) => (
                    <div key={v.version} className="share-panel-soft overflow-hidden rounded-xl">
                      <div className="flex items-center gap-2 border-b border-white/10 bg-gradient-to-r from-indigo-500/15 to-cyan-500/10 px-4 py-2.5">
                        <span className="rounded-full bg-indigo-500 px-2.5 py-0.5 text-[11px] font-bold text-white shadow-md shadow-indigo-500/30">
                          {v.version}
                        </span>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          {v.date}
                        </span>
                        <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
                          {settings.language === 'en' ? 'Release notes' : 'Nota de atualização'}
                        </span>
                      </div>
                      <ul className="divide-y divide-white/5 px-4">
                        {v.items.map((item, i) => (
                          <li key={i} className="flex items-start gap-3 py-2.5">
                            <span
                              className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                item.tag === 'novo'
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : item.tag === 'correcao'
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-sky-500/15 text-sky-300'
                              }`}
                            >
                              {settings.language === 'en'
                                ? item.tag === 'novo'
                                  ? '✨ New'
                                  : item.tag === 'correcao'
                                  ? '🐛 Fix'
                                  : '⚡ Upgrade'
                                : item.tag === 'novo'
                                ? '✨ Novo'
                                : item.tag === 'correcao'
                                ? '🐛 Correção'
                                : '⚡ Melhoria'}
                            </span>
                            <span className="text-sm leading-relaxed text-slate-200">
                              {settings.language === 'en' ? item.en : item.pt}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
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
                      autoComplete="off"
                      className="h-8 w-28 rounded border border-white/20 bg-white/5 px-2 text-base outline-none"
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
              <Avatar name={watchScreen.name} photo={watchScreen.photo} size={22} />
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

      {/* Pop-up de senha para entrar em sala privada */}
      {joinPasswordOpen && joinPasswordRoom && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4">
          <div className="share-panel w-full max-w-sm rounded-2xl p-5">
            <div className="mb-1 flex items-center gap-2 text-lg font-bold">
              🔒 {joinPasswordRoom.name}
            </div>
            <p className="mb-4 text-sm text-slate-300">
              Esta sala é privada e exige senha. Digite para entrar.
            </p>
            <input
              autoFocus
              type="password"
              autoComplete="off"
              name="joinRoomPassword"
              value={joinPasswordValue}
              onChange={(e) => setJoinPasswordValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitJoinPassword()
              }}
              placeholder="Senha da sala"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/20"
            />
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => void submitJoinPassword()}
                disabled={joinPasswordBusy}
                className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:opacity-40"
              >
                {joinPasswordBusy ? 'Entrando...' : 'Entrar na sala'}
              </button>
              <button
                onClick={() => {
                  setJoinPasswordOpen(false)
                  setJoinPasswordRoom(null)
                }}
                className="w-full rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/15"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pop-up de edição de sala */}
      {editingRoom && (
        <div
          className="fixed inset-0 z-[131] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEditingRoom(null)}
        >
          <div
            className="share-panel w-full max-w-sm rounded-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2 text-lg font-bold">
              ✏️ Editar sala
            </div>
            <p className="mb-4 text-sm text-slate-300">
              Ajuste nome, privacidade, senha e capacidade.
            </p>
            <input
              value={editRoomName}
              onChange={(e) => setEditRoomName(e.target.value)}
              maxLength={30}
              placeholder="Nome da sala"
              className="mb-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-amber-400/60 focus:ring-2 focus:ring-amber-500/20"
            />
            <button
              type="button"
              onClick={() => setEditRoomPrivate(!editRoomPrivate)}
              className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/10"
            >
              <span>
                <span className="block text-sm font-semibold text-slate-200">
                  {editRoomPrivate ? '🔒 Privada' : '🌐 Pública'}
                </span>
                <span className="block text-xs text-slate-400">
                  {editRoomPrivate ? 'Só você pode entrar' : 'Qualquer pessoa pode entrar'}
                </span>
              </span>
            </button>
            {editRoomPrivate && (
              <input
                value={editRoomPassword}
                onChange={(e) => setEditRoomPassword(e.target.value)}
                maxLength={30}
                type="password"
                autoComplete="off"
                name="editRoomPassword"
                placeholder="Nova senha (opcional)"
                className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-amber-400/60 focus:ring-2 focus:ring-amber-500/20"
              />
            )}
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold text-slate-300">Capacidade</p>
              <div className="grid grid-cols-3 gap-1.5">
                {[4, 8, 16].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setEditRoomCapacity(c)}
                    className={`rounded-xl border px-2 py-2.5 text-sm font-semibold transition ${
                      editRoomCapacity === c
                        ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {c} pessoas
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => void saveRoom()}
                disabled={savingRoom || !editRoomName.trim()}
                className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:opacity-40"
              >
                {savingRoom ? 'Salvando...' : 'Salvar alterações'}
              </button>
              <button
                onClick={() => setEditingRoom(null)}
                className="w-full rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/15"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pop-up de convite de amigos */}
      {inviteRoom && (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setInviteRoom(null)}
        >
          <div
            className="share-panel w-full max-w-sm rounded-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2 text-lg font-bold">
              📨 Convidar para &quot;{inviteRoom.name}&quot;
            </div>
            <p className="mb-4 text-sm text-slate-300">
              Escolha um amigo para convidar para esta sala.
            </p>
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {inviteLoading ? (
                <p className="py-4 text-center text-sm text-slate-400">Carregando amigos...</p>
              ) : inviteFriends.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">
                  Você ainda não tem amigos para convidar.
                </p>
              ) : (
                inviteFriends.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2">
                    {f.photo ? (
                      <img src={f.photo} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/30 text-sm font-bold">
                        {(f.displayName || '?')[0]}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-200">{f.displayName}</p>
                      <p className="text-[10px] text-slate-400">
                        {f.online ? '● Online' : 'Offline'}
                      </p>
                    </div>
                    <button
                      onClick={() => void sendRoomInvite(f.id)}
                      disabled={inviteSending === f.id}
                      className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      {inviteSending === f.id ? '...' : 'Convidar'}
                    </button>
                  </div>
                ))
              )}
            </div>
            <button
              onClick={() => setInviteRoom(null)}
              className="mt-4 w-full rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/15"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
      {/* Visualização "tela cheia" que acompanha a orientação da câmera */}
      {expandedTileId &&
        (() => {
          const tile = tiles.find((t) => t.id === expandedTileId)
          // Enquanto a câmera está sendo trocada (frontal/traseira), o stream
          // fica vazio por um instante. Nesse momento a tela cheia NÃO desmonta:
          // mostra um indicador e continua aberta até o vídeo voltar.
          if (!tile) return null
          if (!tile.hasVideo || !tile.stream) {
            return (
              <div
                className="fixed inset-0 z-[160] flex items-center justify-center bg-black"
                onClick={() => setExpandedTileId(null)}
              >
                <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                  <span className="text-sm text-slate-400">
                    {settings.language === 'en' ? 'Loading camera…' : 'Carregando câmera…'}
                  </span>
                </div>
                <button
                  onClick={() => setExpandedTileId(null)}
                  title="Fechar"
                  className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-lg bg-black/50 text-base text-white transition hover:bg-black/70"
                >
                  ✕
                </button>
              </div>
            )
          }
          const isScreen = !!tile.isScreen
          const isLocal = !!tile.isLocal
          const muted = isLocal ? !micOn : tile.muted
          const portrait = !isScreen && expandedPortrait
          // A fileira lado a lado (com a sua câmera como principal, nº 1) só
          // entra quando há ao menos uma câmera REMOTA fixada — ou seja, só
          // depois de fixar alguém. Clicar em tela cheia numa câmera ainda não
          // fixada mostra apenas ela (sem a sua).
          const pinnedTiles = pinnedIds
            .map((k) => {
              if (k === 'local-cam') {
                return tiles.find((t) => t.isLocal && !t.isScreen && t.hasVideo)
              }
              if (k.startsWith('peer:')) {
                const pid = k.slice('peer:'.length)
                return tiles.find(
                  (t) => !t.isLocal && !t.isScreen && t.hasVideo && t.peerId === pid
                )
              }
              return undefined
            })
            .filter(
              (t): t is Tile & { stream: MediaStream } => !!t && !!t.hasVideo && !!t.stream
            )
          const hasPinnedRemote = !!pinnedTiles.some((t) => !t.isLocal)
          if (hasPinnedRemote) {
            // Ordem na fileira: 1. minha câmera (esquerda) · 2. a que expandi (meio)
            // · 3. a outra selecionada (direita). Em retrato as três têm o mesmo
            // espaço; em paisagem a do meio (a expandida) ganha mais destaque.
            const ownTile = pinnedTiles.find((t) => t.isLocal)
            const remotes = pinnedTiles.filter((t) => !t.isLocal)
            const expanded = pinnedTiles.find((t) => t.id === expandedTileId)
            const middle = expanded && !expanded.isLocal ? expanded : remotes[0]
            const right = remotes.find((t) => t.id !== middle?.id)
            const row = [ownTile, middle, right].filter(
              (t): t is Tile & { stream: MediaStream } => !!t
            )
            const landscape = !expandedPortrait && row.length > 1
            return (
              <div
                className="fixed inset-0 z-[160] flex items-center justify-center bg-black"
                onClick={() => setExpandedTileId(null)}
              >
                <div
                  className="flex h-full w-full items-stretch justify-center gap-2 p-2 sm:gap-4 sm:p-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.map((pt, i) => {
                    const pLocal = !!pt.isLocal
                    const pScreen = !!pt.isScreen
                    const isMiddle = pt.id === middle?.id
                    return (
                      <div
                        key={pt.id}
                        className={`relative overflow-hidden rounded-lg bg-black ring-1 ring-white/10 ${
                          landscape && isMiddle ? 'flex-[1.45]' : 'flex-1'
                        }`}
                      >
                        <video
                          autoPlay
                          playsInline
                          muted={pLocal || (pScreen ? !!screenMuted[pt.id] : true)}
                          style={{ filter: settings.videoVivid ? 'contrast(1.08) saturate(1.14) brightness(1.03)' : 'none' }}
                          className="h-full w-full object-contain"
                          ref={(el) => {
                            if (el) bind(el, pt.stream)
                          }}
                        />
                        <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/15 text-[10px] font-bold">
                            {i + 1}
                          </span>
                          <span className="max-w-[150px] truncate sm:max-w-[200px]">
                            {pt.name}
                          </span>
                        </span>
                        {isMiddle && (
                          <span className="absolute right-2 top-2 rounded-md bg-emerald-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            Foco
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-slate-300">
                  Câmeras fixadas
                </span>
                <div className="absolute right-2 top-2">
                  <button
                    onClick={() => setExpandedTileId(null)}
                    title="Fechar"
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-black/50 text-base text-white transition hover:bg-black/70"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          }
          return (
            <div
              className="fixed inset-0 z-[160] flex items-center justify-center bg-black"
              onClick={() => setExpandedTileId(null)}
              style={portrait ? { padding: '1rem' } : undefined}
            >
              <div
                className={`relative flex flex-col overflow-hidden bg-black ${
                  portrait ? 'rounded-2xl border border-white/15 shadow-2xl' : 'h-full w-full'
                }`}
                onClick={(e) => e.stopPropagation()}
                style={{
                  aspectRatio: portrait ? '9 / 16' : undefined,
                  width: portrait ? 'auto' : '100%',
                  height: portrait ? 'min(86vh, 740px)' : '100%',
                  maxWidth: portrait ? '94vw' : '100%',
                }}
              >
                <video
                  autoPlay
                  playsInline
                  muted={isLocal || (isScreen ? !!screenMuted[tile.id] : true)}
                  style={{ filter: settings.videoVivid ? 'contrast(1.08) saturate(1.14) brightness(1.03)' : 'none' }}
                  className="h-full w-full object-contain"
                  ref={(el) => {
                    bind(el, tile.stream)
                    if (el) handleExpandedSize(el)
                  }}
                  onLoadedMetadata={(e) => handleExpandedSize(e.currentTarget)}
                  onResize={(e) => handleExpandedSize(e.currentTarget)}
                />
                <div className="absolute right-2 top-2 flex gap-1.5">
                  {isLocal && !isScreen && camOn && isMobileDevice && (
                    <button
                      onClick={flipCamera}
                      title={t('cameraFlip')}
                      className="flex h-9 w-9 items-center justify-center rounded-lg bg-black/50 text-base text-white transition hover:bg-black/70"
                    >
                      🔄
                    </button>
                  )}
                  {!isLocal && !isScreen && (
                    <button
                      onClick={() =>
                        setMutedPeers((prev) => ({
                          ...prev,
                          [tile.peerId as string]: !(mutedPeers[tile.peerId as string] ?? false),
                        }))
                      }
                      title={muted ? 'Desmutar' : 'Mutar'}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg text-base backdrop-blur transition ${
                        muted ? 'bg-red-500/80 hover:bg-red-500' : 'bg-black/50 hover:bg-black/70'
                      }`}
                    >
                      {muted ? '🔇' : '🔊'}
                    </button>
                  )}
                  <button
                    onClick={() => setExpandedTileId(null)}
                    title="Fechar"
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-black/50 text-base text-white transition hover:bg-black/70"
                  >
                    ✕
                  </button>
                </div>
                <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white">
                  {tile.name} {!isLocal && muted ? '· 🔇' : ''}
                </span>
              </div>
            </div>
          )
        })()}
    </div>
  )
}

