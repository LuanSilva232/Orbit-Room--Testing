// Motor WebRTC mesh (malha) para chamadas de voz entre vários usuários.
// Só roda no navegador — é importado por componentes "use client".
import type { SignalKind } from './types'

type Peer = {
  pc: RTCPeerConnection
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
}

export type SendSignal = (payload: { to: string; kind: SignalKind; data: unknown }) => void

export type RtcEngineEvents = {
  onTrack: (peerId: string, stream: MediaStream) => void
  onStreamGone: (peerId: string, stream: MediaStream) => void
  onPeerConnected: (peerId: string) => void
  onPeerGone: (peerId: string) => void
}

export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
]

export class RtcEngine {
  private peers = new Map<string, Peer>()
  private localStreams: MediaStream[] = []

  constructor(
    private readonly myId: string,
    private readonly sendSignal: SendSignal,
    private readonly events: RtcEngineEvents,
    private readonly iceServers: RTCIceServer[] = DEFAULT_ICE
  ) {}

  addPeer(id: string): void {
    if (id === this.myId || this.peers.has(id)) return

    const peer: Peer = {
      pc: new RTCPeerConnection({ iceServers: this.iceServers }),
      polite: this.myId < id,
      makingOffer: false,
      ignoreOffer: false,
    }
    this.peers.set(id, peer)
    const { pc } = peer

    // Adiciona as streams locais atuais ao novo peer (dispara negotiationneeded).
    for (const stream of this.localStreams) {
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream)
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({ to: id, kind: 'ice', data: event.candidate })
      }
    }

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] ?? new MediaStream()
      const track = event.track
      if (track) {
        if (!stream.getTracks().includes(track)) stream.addTrack(track)
        const drop = () => {
          if (!stream.getTracks().includes(track)) return
          stream.removeTrack(track)
          if (stream.getTracks().length === 0) {
            this.events.onStreamGone(id, stream)
          }
        }
        track.addEventListener('ended', drop)
        stream.addEventListener('removetrack', (e) => {
          if (e.track === track) drop()
        })
      }
      this.events.onTrack(id, stream)
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        this.events.onPeerConnected(id)
      } else if (state === 'failed') {
        setTimeout(() => this.restartIce(id), 800)
      } else if (state === 'closed') {
        this.removePeer(id)
      }
    }

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState
      if (st === 'failed' || st === 'disconnected') {
        setTimeout(() => this.restartIce(id), 600)
      }
    }

    // Perfect negotiation com rollback CORRETO.
    // O bug anterior: quando havia colisão de offers (ambos mandam offer ao
    // mesmo tempo), o peer "polite" tentava setRemoteDescription(offer) sem
    // fazer rollback do seu próprio offer pendente. Isso fazia o
    // setRemoteDescription falhar silenciosamente, e a negociação nunca
    // completava para um dos lados — resultado: áudio unidirecional.
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        this.sendSignal({ to: id, kind: 'offer', data: pc.localDescription })
      } catch (error) {
        console.warn('Falha na negociação WebRTC:', error)
      } finally {
        peer.makingOffer = false
      }
    }

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') {
        peer.ignoreOffer = false
      }
    }
  }

  async handleSignal(
    from: string,
    kind: SignalKind,
    data: unknown
  ): Promise<void> {
    let peer = this.peers.get(from)
    if (!peer) {
      this.addPeer(from)
      peer = this.peers.get(from)
      if (!peer) return
    }
    const { pc } = peer

    if (kind === 'offer') {
      const offerCollision =
        peer.makingOffer || pc.signalingState !== 'stable'
      peer.ignoreOffer = !peer.polite && offerCollision
      if (peer.ignoreOffer) return
      try {
        // ROLLBACK: se temos um offer local pendente, desfaz antes de aceitar
        // o offer remoto. Sem isso, setRemoteDescription falha quando o estado
        // é "have-local-offer" e o áudio fica unidirecional.
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' })
        }
        await pc.setRemoteDescription(data as RTCSessionDescriptionInit)
        await pc.setLocalDescription()
        this.sendSignal({ to: from, kind: 'answer', data: pc.localDescription })
      } catch (error) {
        console.warn('Falha ao processar offer:', error)
      }
    } else if (kind === 'answer') {
      try {
        await pc.setRemoteDescription(data as RTCSessionDescriptionInit)
      } catch (error) {
        console.warn('Falha ao processar answer:', error)
      }
    } else if (kind === 'ice') {
      try {
        await pc.addIceCandidate(data as RTCIceCandidateInit)
      } catch (error) {
        if (!peer.ignoreOffer) console.warn('ICE adicionado falhou:', error)
      }
    }
  }

  addLocalStream(stream: MediaStream): void {
    if (this.localStreams.includes(stream)) return
    this.localStreams.push(stream)
    for (const peer of this.peers.values()) {
      for (const track of stream.getTracks()) {
        peer.pc.addTrack(track, stream)
      }
    }
  }

  async setTrackBitrate(track: MediaStreamTrack, maxBitrate: number): Promise<void> {
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track === track)
      if (!sender) continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}]
        }
        params.encodings[0] = { ...params.encodings[0], maxBitrate }
        await sender.setParameters(params)
      } catch {
        /* track ainda não negociado — ignora */
      }
    }
  }

  removeLocalStream(stream: MediaStream): void {
    const idx = this.localStreams.indexOf(stream)
    if (idx >= 0) this.localStreams.splice(idx, 1)
    for (const peer of this.peers.values()) {
      const senders = peer.pc.getSenders()
      for (const sender of senders) {
        if (sender.track && stream.getTracks().includes(sender.track)) {
          peer.pc.removeTrack(sender)
        }
      }
    }
  }

  removeTrack(track: MediaStreamTrack): void {
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track === track)
      if (sender) peer.pc.removeTrack(sender)
    }
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    for (const peer of this.peers.values()) {
      if (peer.pc.getSenders().find((s) => s.track === track)) continue
      peer.pc.addTrack(track, stream)
    }
  }

  restartIce(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    const { pc } = peer
    if (typeof pc.restartIce !== 'function') return
    const st = pc.connectionState
    const ice = pc.iceConnectionState
    if (st === 'failed' || st === 'disconnected' || ice === 'failed' || ice === 'disconnected') {
      try {
        pc.restartIce()
      } catch {
        /* noop */
      }
    }
  }

  // ----- Mudo real do microfone (separado do áudio da tela) -----
  // Salva os senders de áudio mutados para restaurá-los depois.
  private mutedMicSenders = new Set<RTCRtpSender>()

  /** Substitui a trilha de áudio do mic por null em todos os peers (sem renegociação). */
  muteMicAudio(): void {
    this.mutedMicSenders.clear()
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && sender.track.kind === 'audio') {
          void sender.replaceTrack(null)
          this.mutedMicSenders.add(sender)
        }
      }
    }
  }

  /** Restaura a trilha de áudio do mic em todos os peers (sem renegociação). */
  unmuteMicAudio(newTrack: MediaStreamTrack, stream: MediaStream): void {
    for (const peer of this.peers.values()) {
      const senders = peer.pc.getSenders()
      // Peer já estava na chamada quando o mic foi mutado: sender está no Set.
      const muted = senders.find((s) => this.mutedMicSenders.has(s))
      if (muted) {
        void muted.replaceTrack(newTrack)
        continue
      }
      // Peer entrou enquanto o mic estava mutado: sender tem trilha "ended".
      const dead = senders.find((s) => s.track && s.track.kind === 'audio' && s.track.readyState === 'ended')
      if (dead) {
        void dead.replaceTrack(newTrack)
        continue
      }
      // Nenhum sender de áudio existe (trilha foi removida do stream): adiciona.
      peer.pc.addTrack(newTrack, stream)
    }
    this.mutedMicSenders.clear()
  }

  removePeer(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    try {
      peer.pc.close()
    } catch {
      /* noop */
    }
    this.peers.delete(id)
    this.events.onPeerGone(id)
  }

  reconnect(id: string): void {
    if (id === this.myId) return
    const old = this.peers.get(id)
    if (!old) return
    try {
      old.pc.close()
    } catch {
      /* noop */
    }
    this.peers.delete(id)
    this.addPeer(id)
  }

  closeAll(): void {
    for (const id of Array.from(this.peers.keys())) {
      this.removePeer(id)
    }
    this.localStreams = []
  }

  hasPeer(id: string): boolean {
    return this.peers.has(id)
  }

  get hasConnections(): boolean {
    return this.peers.size > 0
  }
}
