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
        // Quando o track é removido (ex.: câmera/tela desligada pelo remoto),
        // limpa o stream e avisa o app se ele ficou vazio — evita "perfil duplicado".
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
      } else if (state === 'failed' || state === 'disconnected') {
        // Deixa um timeout do próprio navegador tentar reconectar antes de remover.
        if (state === 'failed') {
          this.removePeer(id)
        }
      } else if (state === 'closed') {
        this.removePeer(id)
      }
    }

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

  // Limita a taxa de bits de envio de uma trilha (evita travadas no upload
  // durante o compartilhamento de tela em conexões mais lentas).
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

  // Reconstrói a conexão WebRTC com um participante SEM apagar o card dele.
  // Usado quando a aba volta do fundo (ex.: o usuário foi ao Instagram e o
  // navegador suspendeu o batimento): fechamos a conexão antiga (que pode ter
  // "morrido" enquanto a página estava em segundo plano) e abrimos uma nova,
  // mantendo o perfil/foto/stream na tela.
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
