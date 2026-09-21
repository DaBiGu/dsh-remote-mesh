/**
 * Carriers for a mesh link: a direct TCP socket, or a virtual circuit through
 * the public relay. Both hand back a plain duplex byte stream, so everything
 * above this file is carrier-agnostic.
 * @module dsh-remote-workspaces/core/transport
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { Duplex } from 'node:stream'
import { bytesEqual, hmac } from './crypto.js'
import { MeshError, PROTOCOL_VERSION, delay, isNonEmptyString } from './util.js'
import { connectWebSocket } from './ws.js'
import { CLOSE, DATA, ERROR, INCOMING, OPEN, PING, REGISTER, RelayFrameParser, encodeRelayFrame } from './relay-wire.js'

/**
 * Derive the per-machine relay registration token. Binding the token to the
 * machine id means a token captured for one node cannot register another.
 * @param {string} relaySecret - Shared relay secret.
 * @param {string} machineId - Machine claiming the identity.
 * @returns {string} the base64url token.
 */
export function relayToken(relaySecret, machineId) {
  return hmac(relaySecret, `dsh-remote-workspaces/register/v1/${machineId}`).toString('base64url')
}

/** Idle time before the OS starts probing a quiet mesh socket. */
const KEEPALIVE_MS = 30000

/**
 * Start a TCP listener for inbound direct links.
 * @param {{host?: string, port: number}} options - Bind address.
 * @param {(socket: net.Socket) => void} onSocket - Called for every accepted connection.
 * @returns {Promise<{server: net.Server, port: number, close: () => Promise<void>}>} the running listener.
 */
export function listenDirect(options, onSocket) {
  return new Promise((resolve, reject) => {
    /** @type {Set<net.Socket>} */
    const live = new Set()
    const server = net.createServer({ pauseOnConnect: false }, (socket) => {
      socket.setNoDelay(true)
      // A mesh link is idle most of the time. Without keepalive a half-open
      // socket survives a sleeping laptop indefinitely: the peer looks online
      // and every request waits for a timeout instead of reconnecting.
      socket.setKeepAlive(true, KEEPALIVE_MS)
      live.add(socket)
      socket.once('close', () => live.delete(socket))
      onSocket(socket)
    })
    const onError = (error) => {
      server.off('listening', onListening)
      reject(new MeshError('transport/listen', `cannot listen on ${options.host ?? '127.0.0.1'}:${options.port}: ${error.message}`))
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      resolve({
        server,
        port: typeof address === 'object' && address !== null ? address.port : options.port,
        close: () =>
          new Promise((done) => {
            // Stop accepting, then tear down live inbound sockets. Peers redial
            // on their own schedule, so waiting for them to leave would hang.
            server.close(() => done())
            server.closeAllConnections?.()
            for (const socket of live) socket.destroy()
            live.clear()
          }),
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: options.host ?? '127.0.0.1', port: options.port })
  })
}

/**
 * Dial a peer's direct mesh listener.
 * @param {{host: string, port: number, timeoutMs?: number}} options - Peer address.
 * @returns {Promise<net.Socket>} the connected socket.
 */
export function dialDirect(options) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: options.host, port: options.port })
    socket.setNoDelay(true)
    socket.setKeepAlive(true, KEEPALIVE_MS)
    const timeout = setTimeout(() => {
      socket.destroy(new MeshError('transport/timeout', `direct connection to ${options.host}:${options.port} timed out`))
    }, options.timeoutMs ?? 10000)
    timeout.unref?.()
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const onConnect = () => {
      cleanup()
      resolve(socket)
    }
    const onError = (error) => {
      cleanup()
      reject(new MeshError('transport/connect', `cannot reach ${options.host}:${options.port}: ${error.message}`))
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

/**
 * One virtual circuit: a duplex byte stream whose frames the relay switches to
 * the paired circuit on the far node.
 * @augments Duplex
 */
export class Circuit extends Duplex {
  /**
   * @param {RelayClient} client - Owning relay client.
   * @param {number} cid - Circuit id, shared by both endpoints.
   * @param {string} peerId - The node on the far side.
   */
  constructor(client, cid, peerId) {
    super()
    // A relay that drops is routine; the default listener keeps a lost carrier
    // from becoming an unhandled `error` event.
    this.on('error', () => {})
    this.client = client
    this.cid = cid
    this.peerId = peerId
    this.isClosed = false
  }

  /**
   * @param {Buffer} chunk - Bytes for the far side.
   * @param {string} _encoding - Ignored.
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _write(chunk, _encoding, callback) {
    if (this.isClosed) {
      callback(new MeshError('relay/closed', `circuit ${this.cid} is closed`))
      return
    }
    this.client.sendFrame(DATA, { cid: this.cid }, chunk, callback)
  }

  /**
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _final(callback) {
    this.retire()
    callback()
  }

  /**
   * @param {Error|null} error - Destruction cause.
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _destroy(error, callback) {
    this.retire()
    callback(error)
  }

  /** @returns {void} */
  _read() {
    this.client.websocket?.resume()
  }

  /** Tell the relay this circuit is finished and forget it locally. */
  retire() {
    if (this.isClosed) return
    this.isClosed = true
    this.client.circuits.delete(this.cid)
    this.client.sendFrame(CLOSE, { cid: this.cid })
  }

  /**
   * @param {Buffer} payload - Bytes from the far side.
   * @returns {void}
   */
  deliver(payload) {
    if (this.isClosed) return
    if (!this.push(payload)) this.client.websocket?.pause()
  }

  /** The far side closed its end. */
  deliverClose() {
    if (this.isClosed) return
    this.isClosed = true
    this.client.circuits.delete(this.cid)
    this.push(null)
  }
}

/**
 * A node's single persistent connection to the relay.
 *
 * The client registers once, reconnects with capped jittered backoff, keeps the
 * link warm with pings, and exposes `openCircuit(peerId)` plus a `circuit` event
 * for inbound circuits.
 * @fires RelayClient#circuit
 * @fires RelayClient#state
 */
export class RelayClient extends EventEmitter {
  /**
   * @param {{url: string, machineId: string, relaySecret: string, headers?: Record<string,string>, pingIntervalMs?: number, maxBackoffMs?: number, ca?: string|Buffer, rejectUnauthorized?: boolean}} options - Relay endpoint and identity.
   */
  constructor(options) {
    super()
    this.url = options.url
    this.machineId = options.machineId
    this.relaySecret = options.relaySecret
    this.headers = options.headers ?? {}
    this.ca = options.ca
    this.rejectUnauthorized = options.rejectUnauthorized
    this.pingIntervalMs = options.pingIntervalMs ?? 25000
    this.maxBackoffMs = options.maxBackoffMs ?? 15000
    this.websocket = undefined
    this.parser = new RelayFrameParser()
    this.circuits = new Map()
    this.pending = new Map()
    this.attempt = 0
    this.stopped = false
    this.connecting = false
    this.status = 'idle'
    this.lastError = undefined
    this.timer = undefined
    this.pingTimer = undefined
  }

  /** Begin connecting and keep the connection up until {@link RelayClient.stop}. */
  start() {
    this.stopped = false
    void this.connect()
  }

  /** Close the connection and stop reconnecting. */
  stop() {
    this.stopped = true
    this.connecting = false
    clearTimeout(this.timer)
    clearInterval(this.pingTimer)
    this.timer = undefined
    this.pingTimer = undefined
    for (const circuit of [...this.circuits.values()]) circuit.deliverClose()
    this.circuits.clear()
    for (const [, pending] of this.pending) pending.reject(new MeshError('relay/closed', 'relay client stopped'))
    this.pending.clear()
    this.websocket?.destroy()
    this.websocket = undefined
    this.setStatus('stopped')
  }

  /**
   * @param {string} status - New status.
   * @param {string} [error] - Optional failure detail.
   * @returns {void}
   */
  setStatus(status, error) {
    this.status = status
    this.lastError = error
    this.emit('state', { status, error })
  }

  async connect() {
    if (this.stopped) return
    // Overlapping attempts would register this machine twice, and the relay
    // then closes the older socket — leaving whoever still held it waiting on a
    // reply that can never come.
    if (this.connecting) return
    this.connecting = true
    this.setStatus('connecting')
    let websocket
    try {
      websocket = await connectWebSocket(this.url, {
        headers: this.headers,
        timeoutMs: 15000,
        ...(this.ca === undefined ? {} : { ca: this.ca }),
        ...(this.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: this.rejectUnauthorized }),
      })
    } catch (error) {
      this.connecting = false
      this.scheduleReconnect(error instanceof Error ? error.message : String(error))
      return
    }
    this.connecting = false
    if (this.stopped) {
      websocket.destroy()
      return
    }
    this.websocket = websocket
    this.parser = new RelayFrameParser()
    websocket.on('data', (chunk) => this.onData(chunk))
    websocket.on('error', (error) => this.onDrop(error))
    websocket.on('close', () => this.onDrop(undefined))
    this.sendFrame(REGISTER, { id: this.machineId, token: relayToken(this.relaySecret, this.machineId), v: PROTOCOL_VERSION })
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.sendFrame(PING, {}), this.pingIntervalMs)
    this.pingTimer.unref?.()
    this.attempt = 0
    this.setStatus('online')
  }

  /**
   * @param {Error|undefined} error - Why the connection ended.
   * @returns {void}
   */
  onDrop(error) {
    if (this.stopped) return
    const websocket = this.websocket
    this.websocket = undefined
    clearInterval(this.pingTimer)
    websocket?.destroy()
    for (const circuit of [...this.circuits.values()]) circuit.deliverClose()
    this.circuits.clear()
    for (const [, pending] of this.pending) pending.reject(new MeshError('relay/dropped', 'relay connection dropped before the circuit opened'))
    this.pending.clear()
    this.scheduleReconnect(error === undefined ? 'relay connection closed' : error.message)
  }

  /**
   * @param {string} reason - Why a reconnect is due.
   * @returns {void}
   */
  scheduleReconnect(reason) {
    if (this.stopped) return
    this.attempt += 1
    const capped = Math.min(this.maxBackoffMs, 500 * 2 ** Math.min(this.attempt - 1, 6))
    const jitter = capped * (0.5 + Math.random() * 0.5)
    this.setStatus('offline', reason)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.connect(), Math.round(jitter))
    this.timer.unref?.()
  }

  /**
   * Open a circuit to a peer, resolving once the relay has paired it.
   * @param {string} peerId - Target machine id.
   * @param {number} [timeoutMs] - Pairing deadline.
   * @returns {Promise<Circuit>} the paired circuit.
   */
  openCircuit(peerId, timeoutMs = 15000) {
    if (this.websocket === undefined) {
      return Promise.reject(new MeshError('relay/offline', `relay ${this.url} is not connected`))
    }
    const cid = Math.floor(Math.random() * 0xffffffff) >>> 0
    const circuit = new Circuit(this, cid, peerId)
    this.circuits.set(cid, circuit)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(cid)
        circuit.retire()
        reject(new MeshError('relay/timeout', `peer ${peerId} did not appear on the relay within ${timeoutMs}ms`))
      }, timeoutMs)
      timeout.unref?.()
      circuit.once('close', () => clearTimeout(timeout))
      this.pending.set(cid, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      // A send that cannot happen must reject now: leaving the circuit pending
      // turns a dead relay socket into a silent 15-second hang.
      this.sendFrame(OPEN, { to: peerId, cid }, undefined, (error) => {
        if (error === undefined) return
        const waiting = this.pending.get(cid)
        this.pending.delete(cid)
        circuit.retire()
        if (waiting !== undefined) waiting.reject(error)
      })
    })
  }

  /**
   * @returns {boolean} whether the relay socket is present and open.
   */
  isUsable() {
    const websocket = this.websocket
    return websocket !== undefined && !websocket.destroyed && !websocket.isClosed
  }

  /**
   * @param {number} type - Relay frame type.
   * @param {Record<string, unknown>} header - Frame header.
   * @param {Buffer} [payload] - Optional payload.
   * @param {(error?: Error|null) => void} [callback] - Optional completion.
   * @returns {void}
   */
  sendFrame(type, header, payload, callback) {
    const websocket = this.websocket
    if (websocket === undefined || websocket.destroyed || websocket.isClosed) {
      callback?.(new MeshError('relay/offline', 'relay connection is not available'))
      // A socket that is already gone means the status is stale: treat the
      // discovery by use as a drop, so the reconnect starts now instead of at
      // the next TCP event, and the reported status stops lying.
      if (websocket !== undefined && websocket === this.websocket) {
        this.onDrop(new MeshError('relay/offline', 'the relay socket was already closed'))
      }
      return
    }
    const frame = encodeRelayFrame(type, header, payload)
    if (websocket.write(frame)) callback?.()
    else websocket.once('drain', () => callback?.())
  }

  /**
   * @param {Buffer} chunk - One WebSocket message.
   * @returns {void}
   */
  onData(chunk) {
    let frames
    try {
      frames = this.parser.push(chunk)
    } catch (error) {
      this.onDrop(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const frame of frames) this.onFrame(frame)
  }

  /**
   * @param {{type: number, header: Record<string, unknown>, payload: Buffer}} frame - Decoded relay frame.
   * @returns {void}
   */
  onFrame(frame) {
    const cid = typeof frame.header.cid === 'number' ? frame.header.cid : undefined
    switch (frame.type) {
      case INCOMING: {
        if (cid === undefined) return
        const from = String(frame.header.from ?? '')
        const circuit = new Circuit(this, cid, from)
        this.circuits.set(cid, circuit)
        this.emit('circuit', circuit, from)
        return
      }
      case DATA: {
        if (cid === undefined) return
        this.circuits.get(cid)?.deliver(frame.payload)
        return
      }
      case CLOSE: {
        if (cid === undefined) return
        this.circuits.get(cid)?.deliverClose()
        return
      }
      case OPEN: {
        if (cid === undefined) return
        const pending = this.pending.get(cid)
        this.pending.delete(cid)
        const circuit = this.circuits.get(cid)
        if (pending !== undefined && circuit !== undefined) pending.resolve(circuit)
        return
      }
      case ERROR: {
        const reason = String(frame.header.reason ?? 'relay refused the request')
        if (cid !== undefined) {
          const pending = this.pending.get(cid)
          this.pending.delete(cid)
          const circuit = this.circuits.get(cid)
          circuit?.retire()
          if (pending !== undefined) pending.reject(new MeshError('relay/refused', reason))
          return
        }
        // A refusal that names no circuit is about this node's registration.
        // Retrying with the same credentials cannot help, but the reconnect
        // loop is the single place that owns liveness, so hand it the reason
        // instead of throwing out of a socket callback.
        this.onDrop(new MeshError('relay/refused', reason))
        return
      }
      case PING:
      case REGISTER:
        return
      default:
        return
    }
  }
}

/**
 * Constant-time check used by the relay to authenticate a registration.
 * @param {string} relaySecret - Shared secret.
 * @param {string} machineId - Claimed identity.
 * @param {unknown} candidate - Token presented by the node.
 * @returns {boolean} whether the token is correct.
 */
export function verifyRelayToken(relaySecret, machineId, candidate) {
  if (!isNonEmptyString(candidate)) return false
  const expected = relayToken(relaySecret, machineId)
  if (candidate.length !== expected.length) return false
  return bytesEqual(Buffer.from(candidate), Buffer.from(expected))
}

export { delay }
