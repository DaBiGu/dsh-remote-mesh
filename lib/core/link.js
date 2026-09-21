/**
 * An authenticated, encrypted, message-framed link over any duplex byte stream.
 *
 * A link is the only thing the rest of the mesh knows about a peer: once the
 * handshake settles, {@link Link.send} and the `frame` event carry opaque
 * payloads and nothing above this layer has to know whether the bytes arrived
 * over a direct TCP socket or through a virtual circuit on the public relay.
 *
 * Wire shape, both phases: `[4-byte big-endian length][payload]`. During the
 * handshake the payload is a UTF-8 JSON record in the clear (it is a public-key
 * exchange authenticated by the cluster MAC); afterwards every payload is an
 * AEAD-sealed mux frame.
 * @module dsh-remote-workspaces/core/link
 */
import { EventEmitter } from 'node:events'
import { Opener, Sealer, acceptHello, createHello, finishHello } from './crypto.js'
import { MeshError, isRecord } from './util.js'

/** Largest accepted frame, so a hostile peer cannot make the host allocate without bound. */
export const MAX_FRAME = 8 * 1024 * 1024
/** Largest accepted handshake record. */
const MAX_HANDSHAKE = 8 * 1024

/**
 * Reassembles length-prefixed messages from an arbitrarily chunked stream.
 */
class MessageReader {
  constructor(max) {
    this.max = max
    this.buffer = Buffer.alloc(0)
  }

  /**
   * @param {Buffer} chunk - Newly received bytes.
   * @returns {Buffer[]} every message that became complete.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages = []
    for (;;) {
      if (this.buffer.length < 4) break
      const length = this.buffer.readUInt32BE(0)
      if (length > this.max) throw new MeshError('link/frame', `frame of ${length} bytes exceeds the ${this.max}-byte limit`)
      if (this.buffer.length < 4 + length) break
      messages.push(this.buffer.subarray(4, 4 + length))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return messages
  }
}

/**
 * @param {Buffer} payload - Message body.
 * @returns {Buffer} the length-prefixed frame.
 */
export function frame(payload) {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

/**
 * One encrypted link to a peer.
 * @fires Link#frame
 * @fires Link#close
 * @fires Link#error
 */
export class Link extends EventEmitter {
  /**
   * @param {import('node:stream').Duplex} socket - Underlying byte stream.
   * @param {{peerId: string, send: Sealer, receive: Opener, remoteStaticKey: Buffer}} state - Settled handshake state.
   */
  constructor(socket, state) {
    super()
    // A link always reports its end through `close`; `error` is extra detail for
    // whoever wants it. The default listener below exists so that a peer reset —
    // which happens every time the other machine sleeps, reboots or loses the
    // network — can never surface as an unhandled `error` event and take the
    // host process down with it.
    this.on('error', () => {})
    this.socket = socket
    this.peerId = state.peerId
    this.remoteStaticKey = state.remoteStaticKey
    this.send_ = state.send
    this.receive_ = state.receive
    this.reader = new MessageReader(MAX_FRAME)
    this.closed = false
    this.backpressured = false

    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.finish())
    socket.on('end', () => this.finish())
  }

  /**
   * Run the initiator side of the handshake over a fresh socket.
   * @param {import('node:stream').Duplex} socket - Connected byte stream.
   * @param {{machineId: string, identity: {privateKey: Buffer, publicKey: Buffer}, clusterKey: Buffer, expectedPeerId?: string}} options - Local material.
   * @returns {Promise<Link>} the settled link.
   */
  static async dial(socket, options) {
    const { record, state } = createHello(options)
    socket.write(frame(Buffer.from(JSON.stringify(record), 'utf8')))
    const reader = new MessageReader(MAX_HANDSHAKE)
    const ack = await readHandshakeRecord(socket, reader, 'peer ACK')
    const settled = finishHello(ack, state, { clusterKey: options.clusterKey })
    guardExpectedPeer(settled.peerId, options.expectedPeerId)
    const link = new Link(socket, {
      peerId: settled.peerId,
      remoteStaticKey: settled.peerStaticKey,
      send: new Sealer(settled.keys.clientToServer),
      receive: new Opener(settled.keys.serverToClient),
    })
    adoptLeftover(link, reader)
    return link
  }

  /**
   * Run the responder side of the handshake over a fresh socket.
   * @param {import('node:stream').Duplex} socket - Connected byte stream.
   * @param {{machineId: string, identity: {privateKey: Buffer, publicKey: Buffer}, clusterKey: Buffer}} options - Local material.
   * @returns {Promise<Link>} the settled link.
   */
  static async accept(socket, options) {
    const reader = new MessageReader(MAX_HANDSHAKE)
    const hello = await readHandshakeRecord(socket, reader, 'peer HELLO')
    let settled
    try {
      settled = acceptHello(hello, options)
    } catch (error) {
      // Answer in the clear so the initiator gets a readable reason instead of
      // a bare socket close. Nothing here is secret: the handshake already
      // failed and no session key exists.
      refuse(socket, 'authentication refused')
      throw error
    }
    socket.write(frame(Buffer.from(JSON.stringify(settled.record), 'utf8')))
    const link = new Link(socket, {
      peerId: settled.peerId,
      remoteStaticKey: settled.peerStaticKey,
      send: new Sealer(settled.keys.serverToClient),
      receive: new Opener(settled.keys.clientToServer),
    })
    adoptLeftover(link, reader)
    return link
  }

  /**
   * Seal and write one frame.
   * @param {Buffer} payload - Plaintext frame body.
   * @returns {boolean} whether the socket accepted the write without buffering past its high-water mark.
   */
  write(payload) {
    if (this.closed) return false
    const accepted = this.socket.write(frame(this.send_.seal(payload)))
    this.backpressured = !accepted
    return accepted
  }

  /**
   * Wait until the socket has drained back below its high-water mark.
   * @returns {Promise<void>} resolves when writing may continue.
   */
  async drain() {
    if (!this.backpressured || this.closed) return
    await new Promise((resolve) => {
      const done = () => {
        this.socket.off('drain', done)
        this.socket.off('close', done)
        resolve()
      }
      this.socket.on('drain', done)
      this.socket.on('close', done)
    })
    this.backpressured = false
  }

  /** Pause reading from the socket, propagating backpressure to the peer's TCP window. */
  pause() {
    this.socket.pause()
  }

  /** Resume reading from the socket. */
  resume() {
    this.socket.resume()
  }

  /**
   * @param {Buffer} chunk - Raw bytes from the socket.
   * @returns {void}
   */
  onData(chunk) {
    let messages
    try {
      messages = this.reader.push(chunk)
    } catch (error) {
      this.fail(error)
      return
    }
    for (const message of messages) {
      let plaintext
      try {
        plaintext = this.receive_.open(message)
      } catch (error) {
        this.fail(error)
        return
      }
      this.emit('frame', plaintext)
    }
  }

  /**
   * @param {unknown} error - Failure to report.
   * @returns {void}
   */
  fail(error) {
    if (this.closed) return
    const failure = error instanceof Error ? error : new MeshError('link/frame', String(error))
    this.emit('error', failure)
    this.destroy()
  }

  /** Tear the link down. */
  destroy() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.destroy()
    } catch {
      /* the socket may already be gone */
    }
    this.emit('close')
  }

  finish() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

/**
 * Tell a peer in the clear why its handshake was refused, then close.
 * @param {import('node:stream').Duplex} socket - Handshake carrier.
 * @param {string} reason - Short explanation.
 * @returns {void}
 */
function refuse(socket, reason) {
  try {
    socket.write(frame(Buffer.from(JSON.stringify({ v: 1, role: 'error', reason }), 'utf8')))
  } catch {
    /* the socket may already be gone */
  }
}

/**
 * Hand any bytes the handshake reader over-read past the handshake record to
 * the freshly built link, so two frames that shared a TCP segment are not lost.
 * @param {Link} link - Newly constructed link.
 * @param {MessageReader} reader - Reader that may still hold bytes.
 * @returns {void}
 */
function adoptLeftover(link, reader) {
  if (reader.buffer.length === 0) return
  const leftover = reader.buffer
  reader.buffer = Buffer.alloc(0)
  link.onData(leftover)
}

function guardExpectedPeer(actual, expected) {
  if (expected !== undefined && expected !== actual) {
    throw new MeshError('link/identity', `expected peer ${JSON.stringify(expected)} but the handshake named ${JSON.stringify(actual)}`)
  }
}

/**
 * Read exactly one length-prefixed record, consuming whatever the reader kept.
 * @param {import('node:stream').Duplex} socket - Handshake carrier.
 * @param {MessageReader} reader - Reader already holding earlier bytes.
 * @param {string} what - Description for the failure message.
 * @returns {Promise<Record<string, unknown>>} the decoded JSON record.
 */
function readHandshakeRecord(socket, reader, what) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onData = (chunk) => {
      let messages
      try {
        messages = reader.push(chunk)
      } catch (error) {
        done(reject, error)
        return
      }
      if (messages.length === 0) return
      try {
        const record = JSON.parse(messages[0].toString('utf8'))
        if (!isRecord(record)) throw new MeshError('link/protocol', `${what} is not a JSON object`)
        if (record.role === 'error') {
          const reason = typeof record.reason === 'string' ? record.reason : 'the peer refused the handshake'
          throw new MeshError('link/auth', `peer refused the handshake: ${reason}`)
        }
        done(resolve, record)
      } catch (error) {
        done(reject, error)
      }
    }
    const onError = (error) => done(reject, new MeshError('link/transport', `${what} failed: ${error.message}`))
    const onClose = () => done(reject, new MeshError('link/transport', `socket closed before ${what} arrived`))
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('end', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('end', onClose)
    socket.resume?.()
  })
}
