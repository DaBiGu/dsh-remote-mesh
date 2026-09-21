/**
 * The mesh: identity, peer connections, and the stream entry point.
 *
 * One {@link Mesh} runs inside the DSH host process on every machine. It owns
 * the encrypted identity, keeps an outbound link to each configured peer, serves
 * inbound links from its own listener and from relay circuits, and hands out
 * byte streams that address either the peer's in-band API or a loopback TCP
 * endpoint on the peer.
 *
 * A stream is the only primitive the layers above need. The local reverse proxy
 * that puts a peer's whole DSH GUI on `127.0.0.1` and the loopback port forwards
 * used to debug a page on the other machine are both the same three lines.
 * @module dsh-remote-workspaces/core/mesh
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { Duplex } from 'node:stream'
import { Link, frame } from './link.js'
import { Mux } from './mux.js'
import { Circuit, RelayClient, dialDirect, listenDirect } from './transport.js'
import { API_TARGET, MeshError, delay, isRecord, parseTarget, withTimeout } from './util.js'

/** Largest mesh API request or response body. */
const MAX_API_MESSAGE = 4 * 1024 * 1024

/**
 * @param {Record<string, unknown>} message - JSON body.
 * @returns {Buffer} the length-prefixed wire message.
 */
function encodeApiMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * A duplex whose writable side is "bytes from the peer" and whose readable side
 * is "bytes to the peer". The mesh API handler answers on the readable side.
 * @augments Duplex
 */
class ApiDuplex extends Duplex {
  /**
   * @param {(request: Record<string, unknown>) => Promise<unknown>} handler - Request handler.
   */
  constructor(handler) {
    super()
    // An oversized or malformed request is answered, not thrown; the default
    // listener keeps that answer from becoming an unhandled `error` event.
    this.on('error', () => {})
    this.handler = handler
    this.buffer = Buffer.alloc(0)
  }

  /**
   * @param {Buffer} chunk - Bytes the peer sent.
   * @param {string} _encoding - Ignored.
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _write(chunk, _encoding, callback) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 4) break
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_API_MESSAGE) {
        callback(new MeshError('api/size', 'mesh API message exceeds the size limit'))
        return
      }
      if (this.buffer.length < 4 + length) break
      const body = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      void this.answer(body)
    }
    callback()
  }

  /**
   * @param {Buffer} body - One JSON request.
   * @returns {Promise<void>} resolves once the answer is queued.
   */
  async answer(body) {
    let id
    let framed
    try {
      const request = JSON.parse(body.toString('utf8'))
      if (!isRecord(request)) throw new MeshError('api/request', 'request is not a JSON object')
      id = request.id
      const value = await this.handler(request)
      framed = encodeApiMessage({ id, ok: true, value })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof MeshError ? error.code : 'api/failure'
      framed = encodeApiMessage({ id, ok: false, error: { code, message } })
    }
    this.push(framed)
  }

  /** @returns {void} */
  _read() {}
}

/**
 * One configured peer and its live connection, if any.
 */
class Peer {
  /**
   * @param {Record<string, any>} config - Persisted peer record.
   */
  constructor(config) {
    this.config = config
    this.mux = undefined
    this.link = undefined
    this.status = 'idle'
    this.error = undefined
    this.connectedAt = undefined
    this.attempt = 0
    this.timer = undefined
    this.stopped = false
    this.inbound = 0
  }

  /** @returns {string} the peer id. */
  get id() {
    return this.config.id
  }
}

/**
 * The mesh service.
 * @fires Mesh#peers
 */
export class Mesh extends EventEmitter {
  /**
   * @param {{
   *   machineId: string,
   *   machineName: string,
   *   identity: {privateKey: Buffer, publicKey: Buffer},
   *   clusterKey: Buffer,
   *   listenHost?: string,
   *   listenPort?: number,
   *   relay?: {url: string, secret: string},
   *   apiHandler?: (request: Record<string, unknown>, peerId: string) => Promise<unknown>,
   *   onInboundTcp?: (target: {host: string, port: number}, peerId: string) => boolean,
   *   log?: (message: string) => void,
   * }} options - Mesh configuration.
   */
  constructor(options) {
    super()
    this.machineId = options.machineId
    this.machineName = options.machineName
    this.identity = options.identity
    this.clusterKey = options.clusterKey
    this.listenHost = options.listenHost ?? '127.0.0.1'
    this.listenPort = options.listenPort ?? 0
    this.relayConfig = options.relay
    this.apiHandler = options.apiHandler
    this.onInboundTcp = options.onInboundTcp
    this.log = options.log ?? (() => {})
    /** @type {Map<string, Peer>} */
    this.peers = new Map()
    this.listener = undefined
    this.relay = undefined
    this.started = false
    this.boundPort = 0
  }

  /** @returns {Record<string, unknown>} facts about this node, for peers and the UI. */
  describe() {
    return {
      id: this.machineId,
      name: this.machineName,
      publicKey: this.identity.publicKey.toString('base64url'),
      listenHost: this.listenHost,
      listenPort: this.boundPort,
      relay: this.relayConfig === undefined ? undefined : { url: this.relayConfig.url },
      relayStatus: this.relay?.status ?? 'disabled',
      peers: this.snapshotPeers(),
    }
  }

  /** @returns {Record<string, unknown>[]} the live status of every configured peer. */
  snapshotPeers() {
    return [...this.peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.config.name ?? peer.id,
      transport: peer.config.transport ?? 'direct',
      host: peer.config.host,
      port: peer.config.port,
      enabled: peer.config.enabled !== false,
      status: peer.status,
      error: peer.error,
      connectedAt: peer.connectedAt,
      inboundLinks: peer.inbound,
    }))
  }

  /** Start the inbound listener, the relay connection and every peer loop. */
  async start() {
    if (this.started) return
    this.started = true
    // Two harnesses on one machine (the obvious way to try this out) otherwise
    // fight over the default port, and the loser ends up advertising a port it
    // is not listening on — which makes the other side dial its own listener.
    // Walk a few ports instead, and say so loudly.
    let candidate = this.listenPort
    for (let attempt = 0; attempt <= 9 && this.listener === undefined; attempt += 1) {
      try {
        this.listener = await listenDirect({ host: this.listenHost, port: candidate }, (socket) => {
          void this.acceptSocket(socket)
        })
        this.boundPort = this.listener.port
        if (this.listenPort !== 0 && this.boundPort !== this.listenPort) {
          this.log(
            `mesh port ${this.listenPort} was already taken, so this node listens on ${this.boundPort} instead; `
            + 'update the port recorded for this machine on its peers, or give each instance its own mesh port',
          )
        }
        this.log(`mesh listening on ${this.listenHost}:${this.boundPort}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const busy = /EADDRINUSE|address already in use/i.test(message)
        if (!busy || this.listenPort === 0) {
          this.log(`mesh listener unavailable: ${message}`)
          this.listener = undefined
          break
        }
      }
      candidate = this.listenPort + attempt + 1
    }
    if (this.listener === undefined) {
      this.boundPort = 0
      this.log('this node has no direct listener, so peers can only reach it through the relay or by dialling out')
    }
    if (this.relayConfig !== undefined && this.relayConfig.url !== '' && this.relayConfig.secret !== '') {
      this.relay = new RelayClient({
        url: this.relayConfig.url,
        machineId: this.machineId,
        relaySecret: this.relayConfig.secret,
        ...(this.relayConfig.ca === undefined ? {} : { ca: this.relayConfig.ca }),
        ...(this.relayConfig.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: this.relayConfig.rejectUnauthorized }),
      })
      this.relay.on('circuit', (circuit, from) => {
        void this.acceptCircuit(circuit, from)
      })
      this.relay.on('state', () => this.emit('peers'))
      this.relay.start()
    }
    for (const peer of this.peers.values()) {
      // A restart (relay change, new cluster key) must revive peers that an
      // earlier stop marked as parked.
      peer.stopped = false
      peer.attempt = 0
      this.wake(peer)
    }
  }

  /** Stop listening, drop every link and stop reconnecting. */
  async stop() {
    this.started = false
    for (const peer of this.peers.values()) {
      peer.stopped = true
      clearTimeout(peer.timer)
      peer.mux?.destroy(new MeshError('mesh/stopped', 'mesh stopped'))
      peer.mux = undefined
      peer.link = undefined
      peer.status = 'idle'
    }
    this.relay?.stop()
    this.relay = undefined
    const listener = this.listener
    this.listener = undefined
    if (listener !== undefined) await listener.close()
  }

  /**
   * Replace the configured peer set. Peers that disappeared are closed; new
   * peers are dialled; changed peers are re-dialled.
   * @param {Record<string, any>[]} configs - Desired peer records.
   * @returns {Promise<void>} resolves once the set is reconciled.
   */
  async setPeers(configs) {
    const desired = new Map(configs.map((config) => [config.id, config]))
    for (const [id, peer] of [...this.peers]) {
      const next = desired.get(id)
      if (next === undefined) {
        peer.stopped = true
        clearTimeout(peer.timer)
        peer.mux?.destroy(new MeshError('mesh/removed', 'peer removed'))
        this.peers.delete(id)
        continue
      }
      const changed = JSON.stringify(stripVolatile(peer.config)) !== JSON.stringify(stripVolatile(next))
      peer.config = next
      if (changed) {
        peer.mux?.destroy(new MeshError('mesh/reload', 'peer configuration changed'))
        peer.mux = undefined
        peer.status = 'idle'
        peer.attempt = 0
        this.wake(peer)
      }
    }
    for (const [id, config] of desired) {
      if (this.peers.has(id)) continue
      const peer = new Peer(config)
      this.peers.set(id, peer)
      if (this.started) this.wake(peer)
    }
    this.emit('peers')
  }

  /**
   * Ensure a peer is connected, then open one stream to a target on it.
   * @param {string} peerId - Peer machine id.
   * @param {string} target - `#api` or a loopback `host:port`.
   * @param {{timeoutMs?: number}} [options] - Connect deadline.
   * @returns {Promise<Duplex>} the stream.
   */
  async stream(peerId, target, options = {}) {
    const peer = this.peers.get(peerId)
    if (peer === undefined) throw new MeshError('mesh/unknown-peer', `no peer named ${JSON.stringify(peerId)} is configured`)
    if (peer.config.enabled === false) throw new MeshError('mesh/disabled', `peer ${JSON.stringify(peerId)} is disabled`)
    const timeoutMs = options.timeoutMs ?? 12000
    // A link can die between the moment it is chosen and the moment the peer
    // answers — the relay restarts, the far machine wakes up, a socket times
    // out. Failing the caller for that would make every reconnect cost one
    // visible error, so an open that lands on a dead link is retried once on a
    // fresh one. A refusal with a live link (nothing listening over there) is
    // final and is never retried.
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const mux = await this.ensureMux(peer, timeoutMs)
      const stream = mux.open(target)
      // Waiting for the peer's acknowledgement is what makes "nothing is
      // listening over there" arrive as a reason instead of a later reset. The
      // outcome is a value, not a rejection, so a teardown racing this await
      // cannot become an unhandled rejection.
      const opened = await withTimeout(stream.opened, timeoutMs, `open ${target} on ${peerId}`)
      if (opened?.ok === true) return stream
      lastError = opened?.error ?? new MeshError('mux/open', `opening ${target} on ${peerId} was refused`)
      stream.destroy()
      if (mux.closed) {
        if (peer.mux === mux) peer.mux = undefined
        continue
      }
      throw lastError
    }
    throw lastError ?? new MeshError('mesh/offline', `could not open ${target} on ${peerId}`)
  }

  /**
   * Call one operation on the peer's mesh API.
   * @param {string} peerId - Peer machine id.
   * @param {string} op - Operation name.
   * @param {Record<string, unknown>} [payload] - Operation payload.
   * @param {{timeoutMs?: number}} [options] - Call deadline.
   * @returns {Promise<unknown>} the peer's answer.
   */
  async call(peerId, op, payload = {}, options = {}) {
    const stream = await this.stream(peerId, API_TARGET, options)
    stream.write(encodeApiMessage({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, op, payload }))
    try {
      const response = await withTimeout(readApiResponse(stream), options.timeoutMs ?? 12000, `mesh API call ${op}`)
      if (response.ok === true) return response.value
      const error = isRecord(response.error) ? response.error : {}
      throw new MeshError(String(error.code ?? 'api/failure'), String(error.message ?? 'peer refused the call'))
    } finally {
      stream.destroy()
    }
  }

  /**
   * Bring a peer's outbound link up, if it is not already.
   * @param {Peer} peer - Peer record.
   * @param {number} timeoutMs - How long to wait.
   * @returns {Promise<Mux>} the live multiplexer.
   */
  async ensureMux(peer, timeoutMs) {
    if (peer.mux !== undefined && !peer.mux.closed) return peer.mux
    const deadline = Date.now() + timeoutMs
    const started = this.dial(peer)
    // A concurrent dial may already be in flight; waiting on the peer's promise
    // rather than the local one keeps every caller on the same connection.
    while (Date.now() < deadline) {
      try {
        await started
      } catch {
        /* the loop below re-reads the live state */
      }
      if (peer.mux !== undefined && !peer.mux.closed) return peer.mux
      if (peer.status === 'offline' || peer.status === 'idle') this.wake(peer)
      await delay(250)
    }
    throw new MeshError('mesh/offline', `peer ${JSON.stringify(peer.id)} did not come online: ${peer.error ?? 'no route'}`)
  }

  /**
   * Dial a peer once, updating its status. Concurrent calls share one attempt.
   * @param {Peer} peer - Peer record.
   * @returns {Promise<void>} resolves when the attempt settles.
   */
  async dial(peer) {
    if (peer.dialing !== undefined) return peer.dialing
    peer.dialing = this.dialOnce(peer).finally(() => {
      peer.dialing = undefined
    })
    return peer.dialing
  }

  /**
   * One dial attempt. This never rejects: it runs on a background reconnect
   * loop, and a rejection nobody awaits is an unhandled rejection — which can
   * take the whole host process down for something as ordinary as a listener
   * that threw. Every failure becomes peer state instead.
   * @param {Peer} peer - Peer record.
   * @returns {Promise<void>} always resolves.
   */
  async dialOnce(peer) {
    try {
      await this.dialAttempt(peer)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      peer.status = 'offline'
      peer.error = reason
      try {
        this.emit('peers')
      } catch {
        /* a listener throwing must not escalate here */
      }
      try {
        this.log(`dialling ${peer.id} failed unexpectedly: ${reason}`)
      } catch {
        /* logging must never be the thing that breaks a dial */
      }
    }
  }

  /**
   * The body of one dial attempt.
   * @param {Peer} peer - Peer record.
   * @returns {Promise<void>} resolves when the attempt settles.
   */
  async dialAttempt(peer) {
    if (peer.mux !== undefined && !peer.mux.closed) return
    peer.status = 'connecting'
    peer.error = undefined
    this.emit('peers')
    let carrier
    try {
      carrier = await this.carrierTo(peer)
    } catch (error) {
      peer.status = 'offline'
      peer.error = error instanceof Error ? error.message : String(error)
      this.emit('peers')
      return
    }
    try {
      const link = await withTimeout(
        Link.dial(carrier, {
          machineId: this.machineId,
          identity: this.identity,
          clusterKey: this.clusterKey,
          expectedPeerId: peer.id,
        }),
        12000,
        `handshake with ${peer.id}`,
      )
      this.attach(peer, link, true)
      peer.attempt = 0
      this.log(`mesh link to ${peer.id} established over ${peer.config.transport ?? 'direct'}`)
    } catch (error) {
      peer.status = 'offline'
      const reason = error instanceof Error ? error.message : String(error)
      // Dialling our own listener is a specific, confusing misconfiguration:
      // say what actually happened instead of quoting the handshake guard.
      peer.error = reason.includes(`the handshake named ${JSON.stringify(this.machineId)}`)
        ? `${peer.id} is configured with this machine's own address (${peer.config.host ?? ''}:${peer.config.port ?? ''}); on two machines that is fine, but two harnesses on one machine need different mesh listen ports`
        : reason
      carrier.destroy?.()
      this.emit('peers')
    }
  }

  /**
   * @param {Peer} peer - Peer record.
   * @returns {Promise<Duplex>} a carrier stream to the peer.
   */
  async carrierTo(peer) {
    const transport = peer.config.transport ?? 'direct'
    if (transport === 'relay') {
      if (this.relay === undefined) throw new MeshError('mesh/relay', 'this node has no relay configured')
      return this.relay.openCircuit(peer.id)
    }
    if (transport === 'direct') {
      if (typeof peer.config.host !== 'string' || peer.config.host === '') {
        throw new MeshError('mesh/config', `peer ${peer.id} has no host`)
      }
      const port = Number(peer.config.port)
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
        throw new MeshError('mesh/config', `peer ${peer.id} has no usable port`)
      }
      return dialDirect({ host: peer.config.host, port })
    }
    throw new MeshError('mesh/config', `peer ${peer.id} names an unknown transport ${JSON.stringify(transport)}`)
  }

  /**
   * Attach a settled link as the peer's outbound connection.
   * @param {Peer} peer - Peer record.
   * @param {Link} link - Settled link.
   * @param {boolean} outbound - Whether this node initiated the link.
   * @returns {void}
   */
  attach(peer, link, outbound) {
    // A link failure is expected whenever the other machine sleeps, reboots or
    // loses its network. It is reported and then handled through `close`.
    link.on('error', (error) => {
      this.log(`link to ${peer.id} failed: ${error.message}`)
    })
    const mux = new Mux(link, {
      isInitiator: outbound,
      onOpen: (target) => this.openInbound(peer.id, target),
    })
    if (outbound) {
      peer.mux = mux
      peer.link = link
      peer.status = 'online'
      peer.error = undefined
      peer.connectedAt = Date.now()
      link.on('close', () => {
        if (peer.mux !== mux) return
        peer.mux = undefined
        peer.link = undefined
        peer.status = 'offline'
        peer.error = 'link closed'
        this.emit('peers')
        this.wake(peer)
      })
    } else {
      peer.inbound += 1
      link.on('close', () => {
        peer.inbound = Math.max(0, peer.inbound - 1)
        this.emit('peers')
      })
    }
    this.emit('peers')
  }

  /**
   * Policy for a stream a peer opened on this machine.
   * @param {string} peerId - Peer that asked.
   * @param {string} target - Requested target.
   * @returns {Duplex} the local endpoint.
   */
  openInbound(peerId, target) {
    const parsed = parseTarget(target)
    if (parsed.kind === 'api') {
      return new ApiDuplex(async (request) => {
        if (this.apiHandler === undefined) throw new MeshError('api/disabled', 'this machine exposes no mesh API')
        return this.apiHandler(request, peerId)
      })
    }
    if (this.onInboundTcp !== undefined && this.onInboundTcp(parsed, peerId) === false) {
      throw new MeshError('mesh/denied', `peer ${peerId} is not allowed to reach ${target}`)
    }
    // Resolve only once the loopback endpoint really accepted the connection:
    // an unreachable target has to become a refusal, not a silent reset.
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: parsed.host, port: parsed.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new MeshError('mesh/target', `${target} 上没有任何服务在监听（连接超时）`))
      }, 8000)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.setNoDelay(true)
        socket.on('error', (error) => this.log(`inbound tunnel to ${target} failed: ${error.message}`))
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        socket.destroy()
        const code = error.code ?? error.message
        reject(new MeshError('mesh/target', `${target} 上没有任何服务在监听（${code}）`))
      })
    })
  }

  /**
   * @param {net.Socket} socket - Accepted direct connection.
   * @returns {Promise<void>} resolves when the link settles or fails.
   */
  async acceptSocket(socket) {
    socket.setNoDelay(true)
    try {
      const link = await withTimeout(
        Link.accept(socket, { machineId: this.machineId, identity: this.identity, clusterKey: this.clusterKey }),
        12000,
        'inbound handshake',
      )
      this.adoptInbound(link)
    } catch (error) {
      this.log(`inbound link refused: ${error instanceof Error ? error.message : String(error)}`)
      socket.destroy()
    }
  }

  /**
   * @param {Circuit} circuit - Relay circuit offered by the relay.
   * @param {string} from - The node on the far side.
   * @returns {Promise<void>} resolves when the link settles or fails.
   */
  async acceptCircuit(circuit, from) {
    try {
      const link = await withTimeout(
        Link.accept(circuit, { machineId: this.machineId, identity: this.identity, clusterKey: this.clusterKey }),
        12000,
        `relay handshake with ${from}`,
      )
      this.adoptInbound(link)
    } catch (error) {
      this.log(`relay circuit from ${from} refused: ${error instanceof Error ? error.message : String(error)}`)
      circuit.destroy()
    }
  }

  /**
   * Register a settled inbound link. A peer may be arriving before this node
   * has it configured, in which case the link is served but no outbound state
   * is created for it.
   * @param {Link} link - Settled inbound link.
   * @returns {void}
   */
  adoptInbound(link) {
    const peer = this.peers.get(link.peerId)
    if (peer === undefined) {
      // Serve it: inbound policy still authenticates every stream, and the UI
      // surfaces the unexpected node so the operator can enrol it.
      const unknown = new Peer({ id: link.peerId, name: link.peerId, transport: 'inbound', enabled: false })
      unknown.status = 'online'
      unknown.stopped = true
      this.peers.set(link.peerId, unknown)
      this.attach(unknown, link, false)
      this.log(`inbound link from unconfigured node ${link.peerId}`)
      return
    }
    this.attach(peer, link, false)
  }

  /**
   * Schedule the next dial attempt for a peer with capped jittered backoff.
   * @param {Peer} peer - Peer record.
   * @returns {void}
   */
  wake(peer) {
    if (!this.started || peer.stopped || peer.config.enabled === false) return
    if (peer.status === 'online' || peer.status === 'connecting') return
    clearTimeout(peer.timer)
    peer.attempt += 1
    const capped = Math.min(15000, 500 * 2 ** Math.min(peer.attempt - 1, 5))
    const wait = Math.round(capped * (0.5 + Math.random() * 0.5))
    peer.timer = setTimeout(() => {
      if (!this.started || peer.stopped) return
      void this.dial(peer).then(
        () => {
          if (peer.status !== 'online') this.wake(peer)
        },
        (error) => {
          // dialOnce no longer rejects, but a background loop must never be the
          // source of an unhandled rejection even if that changes.
          try {
            this.log(`reconnect attempt for ${peer.id} failed: ${error instanceof Error ? error.message : String(error)}`)
          } catch {
            /* logging is best effort */
          }
          this.wake(peer)
        },
      )
    }, wait)
    peer.timer.unref?.()
  }
}

/**
 * Read one length-prefixed JSON answer from a stream.
 * @param {Duplex} stream - Stream carrying the answer.
 * @returns {Promise<Record<string, unknown>>} the decoded answer.
 */
function readApiResponse(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('close', onClose)
    }
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 4) break
        const length = buffer.readUInt32BE(0)
        if (length > MAX_API_MESSAGE) {
          cleanup()
          reject(new MeshError('api/size', 'mesh API answer exceeds the size limit'))
          return
        }
        if (buffer.length < 4 + length) break
        const body = buffer.subarray(4, 4 + length)
        cleanup()
        try {
          const parsed = JSON.parse(body.toString('utf8'))
          if (!isRecord(parsed)) throw new MeshError('api/response', 'answer is not a JSON object')
          resolve(parsed)
        } catch (error) {
          reject(error)
        }
        return
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error instanceof MeshError ? error : new MeshError('api/transport', error.message))
    }
    const onClose = () => {
      cleanup()
      reject(new MeshError('api/closed', 'peer closed the API stream before answering'))
    }
    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('close', onClose)
  })
}

function stripVolatile(config) {
  const { name, transport, host, port, enabled } = config
  return { name, transport, host, port, enabled }
}

export { frame }
