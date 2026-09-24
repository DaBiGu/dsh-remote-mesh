/**
 * Stream multiplexing over one encrypted link.
 *
 * A mux turns a single {@link Link} into an arbitrary number of independent,
 * ordered, backpressured byte streams. Each stream either addresses the peer's
 * in-band mesh API (the reserved `#api` target) or a loopback TCP endpoint on
 * the peer, which is what makes the local reverse proxy and the port forwards
 * plain byte plumbing instead of protocol-specific code.
 *
 * Frame shape inside the link: `[1-byte type][4-byte stream id][payload]`.
 * @module dsh-remote-mesh/core/mux
 */
import { Duplex } from 'node:stream'
import { MeshError } from './util.js'

/** Open a new stream with a target. */
export const OPEN = 1
/** Payload bytes for an open stream. */
export const DATA = 2
/** Sender will send nothing more on this stream. */
export const FIN = 3
/** Abort this stream immediately. */
export const RESET = 4
/** The peer refused to open the stream; the payload is the reason. */
export const OPEN_ERR = 5
/**
 * The peer accepted the stream and its local endpoint is live. This is what
 * lets a caller learn that a tunnel target has no listener instead of writing
 * into a stream that will be reset a moment later.
 */
export const OPEN_OK = 6

const HEADER = 5
/** Largest single DATA frame the mux will emit. */
const MAX_CHUNK = 256 * 1024

/**
 * One ordered byte stream inside a mux.
 * @augments Duplex
 */
export class MuxStream extends Duplex {
  /**
   * @param {Mux} mux - Owning multiplexer.
   * @param {number} id - Wire stream id.
   * @param {string} target - Requested target, for diagnostics.
   */
  constructor(mux, id, target) {
    super()
    // A refused open and an aborted transfer are ordinary outcomes here, and
    // this stream is piped into local sockets that do not forward errors.
    // Without a default listener the first reset from a peer would become an
    // unhandled `error` event and crash the host process.
    this.on('error', () => {})
    this.mux = mux
    this.id = id
    this.target = target
    this.finishedSending = false
    this.aborted = false
  }

  /**
   * @param {Buffer} chunk - Payload to send.
   * @param {string} _encoding - Ignored; the stream is binary.
   * @param {(error?: Error|null) => void} callback - Write completion.
   * @returns {void}
   */
  _write(chunk, _encoding, callback) {
    if (this.aborted) {
      callback(new MeshError('mux/closed', 'stream is closed'))
      return
    }
    // Split oversized writes so one huge chunk cannot monopolise the link.
    let offset = 0
    const step = () => {
      if (offset >= chunk.length) {
        callback()
        return
      }
      const slice = chunk.subarray(offset, Math.min(offset + MAX_CHUNK, chunk.length))
      offset += slice.length
      if (this.mux.writeFrame(DATA, this.id, slice)) step()
      else this.mux.link.drain().then(step, (error) => callback(error))
    }
    step()
  }

  /**
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _final(callback) {
    if (!this.aborted) {
      this.finishedSending = true
      this.mux.writeFrame(FIN, this.id, Buffer.alloc(0))
    }
    callback()
  }

  /**
   * @param {Error|null} error - Destruction cause.
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _destroy(error, callback) {
    if (!this.aborted) {
      this.aborted = true
      this.mux.forget(this.id)
      // A stream that ended cleanly needs no RESET: the peer already saw FIN.
      if (!this.finishedSending) this.mux.writeFrame(RESET, this.id, Buffer.alloc(0))
    }
    this.mux.releasePause()
    callback(error)
  }

  /** @returns {void} */
  _read() {
    this.mux.releasePause()
  }

  /**
   * Deliver peer bytes to the consumer.
   * @param {Buffer} payload - Data frame payload.
   * @returns {void}
   */
  deliver(payload) {
    if (this.aborted) return
    if (!this.push(payload)) this.mux.claimPause()
  }

  /** Peer half-closed: end the readable side once the buffer drains. */
  deliverFin() {
    if (this.aborted) return
    this.push(null)
  }

  /**
   * The peer refused this stream.
   * @param {string} reason - Peer-provided explanation.
   * @returns {void}
   */
  deliverOpenError(reason) {
    this.destroy(new MeshError('mux/open', reason === '' ? `peer refused ${this.target}` : reason))
  }
}

/**
 * Multiplexer over one link.
 * @fires Mux#error
 */
export class Mux {
  /**
   * @param {import('./link.js').Link} link - Settled encrypted link.
   * @param {{isInitiator: boolean, onOpen?: (target: string) => import('node:stream').Duplex}} options - Role and inbound-stream policy.
   */
  constructor(link, options) {
    this.link = link
    this.isInitiator = options.isInitiator
    this.onOpen = options.onOpen
    this.streams = new Map()
    this.counter = 0
    this.pendingOpen = new Map()
    this.pausedStreams = 0
    this.linkPaused = false
    this.closed = false
    this.link.on('frame', (payload) => this.onFrame(payload))
    this.link.on('close', () => this.destroy(new MeshError('mux/closed', `link to ${link.peerId} closed`)))
  }

  /** @returns {string} the peer's machine id. */
  get peerId() {
    return this.link.peerId
  }

  /**
   * Open a stream to a target on the peer.
   * @param {string} target - Reserved `#api` target or a loopback `host:port` endpoint.
   * @returns {MuxStream} the new stream, carrying an `opened` promise that
   *   settles when the peer confirms its local endpoint is live.
   */
  open(target) {
    if (this.closed) throw new MeshError('mux/closed', 'multiplexer is closed')
    const id = ((this.counter += 1) * 2) + (this.isInitiator ? 0 : 1)
    const stream = new MuxStream(this, id, target)
    this.streams.set(id, stream)
    stream.once('close', () => this.streams.delete(id))
    // This settles with a result and NEVER rejects. Network teardown can settle
    // it at any moment — the relay dropping, the peer vanishing, the mux being
    // replaced — and a promise like that is a foot-gun: any teardown while the
    // opener is queued behind other work becomes an unhandled rejection, which
    // Node escalates to an uncaught exception and the host dies.
    stream.opened = new Promise((resolve) => {
      this.pendingOpen.set(id, { resolve })
      stream.once('close', () => this.settleOpen(id, {
        ok: false,
        error: new MeshError('mux/closed', `stream to ${target} closed before the peer confirmed it`),
      }))
    })
    this.writeFrame(OPEN, id, Buffer.from(target, 'utf8'))
    return stream
  }

  /**
   * Settle a pending open exactly once.
   * @param {number} id - Stream id.
   * @param {{ok: boolean, error?: Error}} outcome - The result to report.
   * @returns {void}
   */
  settleOpen(id, outcome) {
    const pending = this.pendingOpen.get(id)
    if (pending === undefined) return
    this.pendingOpen.delete(id)
    pending.resolve(outcome)
  }

  /**
   * Encode and write one frame.
   * @param {number} type - Frame type.
   * @param {number} id - Stream id.
   * @param {Buffer} payload - Frame body.
   * @returns {boolean} whether the link accepted the write immediately.
   */
  writeFrame(type, id, payload) {
    if (this.closed) return false
    const frame = Buffer.allocUnsafe(HEADER + payload.length)
    frame.writeUInt8(type, 0)
    frame.writeUInt32BE(id, 1)
    payload.copy(frame, HEADER)
    return this.link.write(frame)
  }

  /**
   * @param {Buffer} payload - Decoded link frame.
   * @returns {void}
   */
  onFrame(payload) {
    if (payload.length < HEADER) {
      this.destroy(new MeshError('mux/frame', 'mux frame is shorter than its header'))
      return
    }
    const type = payload.readUInt8(0)
    const id = payload.readUInt32BE(1)
    const body = payload.subarray(HEADER)
    switch (type) {
      case OPEN:
        this.acceptOpen(id, body.toString('utf8'))
        return
      case DATA:
        this.streams.get(id)?.deliver(body)
        return
      case FIN:
        this.streams.get(id)?.deliverFin()
        return
      case RESET: {
        const stream = this.streams.get(id)
        this.streams.delete(id)
        stream?.destroy()
        return
      }
      case OPEN_ERR: {
        const stream = this.streams.get(id)
        this.streams.delete(id)
        const reason = body.toString('utf8')
        this.settleOpen(id, { ok: false, error: new MeshError('mux/open', reason || `peer refused ${id}`) })
        stream?.deliverOpenError(reason)
        return
      }
      case OPEN_OK: {
        this.settleOpen(id, { ok: true })
        return
      }
      default:
        this.destroy(new MeshError('mux/frame', `unknown mux frame type ${type}`))
    }
  }

  /**
   * Serve a peer-initiated stream by asking the policy for a local duplex and
   * wiring the two together in both directions.
   * @param {number} id - Peer-allocated stream id.
   * @param {string} target - Requested target.
   * @returns {void}
   */
  acceptOpen(id, target) {
    if (this.streams.has(id)) {
      this.writeFrame(OPEN_ERR, id, Buffer.from('duplicate stream id', 'utf8'))
      return
    }
    if (this.onOpen === undefined) {
      this.writeFrame(OPEN_ERR, id, Buffer.from('this machine accepts no inbound streams', 'utf8'))
      return
    }
    const peerSide = new MuxStream(this, id, target)
    this.streams.set(id, peerSide)
    peerSide.on('close', () => this.streams.delete(id))

    // The policy may hand back a live duplex or a promise for one — a tunnelled
    // TCP target only proves itself once it connects. Waiting here is what turns
    // "nothing is listening over there" into a refusal the caller can report.
    let result
    try {
      result = this.onOpen(target)
    } catch (error) {
      this.streams.delete(id)
      this.refuse(id, error, peerSide)
      return
    }
    Promise.resolve(result).then(
      (local) => {
        if (this.closed || peerSide.aborted) {
          local.destroy?.()
          return
        }
        this.wireInbound(id, peerSide, local)
        this.writeFrame(OPEN_OK, id, Buffer.alloc(0))
      },
      (error) => {
        this.streams.delete(id)
        this.refuse(id, error, peerSide)
      },
    )
  }

  /**
   * Tell the opener that this stream will not be served.
   * @param {number} id - Stream id.
   * @param {unknown} error - Why it was refused.
   * @param {MuxStream} peerSide - The local placeholder for the stream.
   * @returns {void}
   */
  refuse(id, error, peerSide) {
    const reason = error instanceof Error ? error.message : String(error)
    this.writeFrame(OPEN_ERR, id, Buffer.from(reason, 'utf8'))
    peerSide.destroy()
  }

  /**
   * Wire a live local endpoint to its peer-facing stream.
   * @param {number} id - Stream id.
   * @param {MuxStream} peerSide - The peer-facing duplex.
   * @param {import('node:stream').Duplex} local - The local endpoint.
   * @returns {void}
   */
  wireInbound(id, peerSide, local) {
    // Peer -> local: peerSide's readable bytes are the local socket's input.
    peerSide.pipe(local)
    peerSide.on('close', () => {
      this.streams.delete(id)
      if (!local.destroyed) local.destroy()
    })

    // Local -> peer: read the local socket and frame it, pausing it while the
    // link is backpressured so a slow network never buffers in memory.
    local.on('data', (chunk) => {
      if (peerSide.aborted) return
      if (this.writeFrame(DATA, id, chunk)) return
      local.pause()
      void this.link.drain().then(() => {
        if (!local.destroyed) local.resume()
      })
    })
    local.on('end', () => {
      if (!peerSide.aborted) this.writeFrame(FIN, id, Buffer.alloc(0))
    })
    local.on('error', (error) => {
      if (!peerSide.aborted) {
        this.writeFrame(RESET, id, Buffer.alloc(0))
        peerSide.destroy(error)
      }
      this.streams.delete(id)
    })
    local.on('close', () => {
      this.streams.delete(id)
      if (!peerSide.aborted) peerSide.destroy()
    })
    local.resume()
  }

  /**
   * Drop a stream from the table.
   * @param {number} id - Stream id.
   * @returns {void}
   */
  forget(id) {
    this.streams.delete(id)
  }

  /** Claim one global pause and stop reading the link. */
  claimPause() {
    this.pausedStreams += 1
    if (this.linkPaused) return
    this.linkPaused = true
    this.link.pause()
  }

  /** Release one pause and, at zero, resume reading the link. */
  releasePause() {
    if (this.pausedStreams > 0) this.pausedStreams -= 1
    if (this.pausedStreams > 0) return
    if (!this.linkPaused) return
    this.linkPaused = false
    this.link.resume()
  }

  /**
   * Close every stream and the link.
   * @param {Error} [reason] - Cause reported to stream consumers.
   * @returns {void}
   */
  destroy(reason) {
    if (this.closed) return
    this.closed = true
    const failure = reason ?? new MeshError('mux/closed', 'multiplexer closed')
    for (const id of [...this.pendingOpen.keys()]) this.settleOpen(id, { ok: false, error: failure })
    this.pendingOpen.clear()
    for (const stream of [...this.streams.values()]) stream.destroy(failure)
    this.streams.clear()
    this.link.destroy()
  }
}
