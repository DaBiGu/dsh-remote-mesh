/**
 * A small RFC 6455 WebSocket codec, used only for the relay carrier.
 *
 * The relay exists so two machines behind different NATs can reach each other
 * through a server that is already serving TLS. WebSocket is the one
 * full-duplex protocol every reverse proxy in existence (nginx included)
 * upgrades correctly, so both nodes hold one long-lived client socket to the
 * relay and the relay switches virtual circuits between them.
 *
 * Only what the relay needs is implemented: binary messages, fragmentation on
 * receive, control frames, and client-side masking.
 * @module dsh-remote-workspaces/core/ws
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Duplex } from 'node:stream'
import { MeshError } from './util.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Largest accepted message, so a hostile peer cannot exhaust memory. */
const MAX_MESSAGE = 16 * 1024 * 1024

/**
 * @param {string} key - The client's `Sec-WebSocket-Key`.
 * @returns {string} the `Sec-WebSocket-Accept` answer.
 */
export function computeAccept(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/**
 * Encode one WebSocket frame.
 * @param {number} opcode - Frame opcode.
 * @param {Buffer} payload - Frame body.
 * @param {boolean} mask - Whether to mask (clients must, servers must not).
 * @returns {Buffer} the encoded frame.
 */
export function encodeFrame(opcode, payload, mask) {
  const length = payload.length
  let headerLength = 2
  if (length >= 126 && length <= 0xffff) headerLength += 2
  else if (length > 0xffff) headerLength += 8
  if (mask) headerLength += 4
  const frame = Buffer.allocUnsafe(headerLength + length)
  frame.writeUInt8(0x80 | opcode, 0)
  let offset = 2
  if (length < 126) {
    frame.writeUInt8((mask ? 0x80 : 0) | length, 1)
  } else if (length <= 0xffff) {
    frame.writeUInt8((mask ? 0x80 : 0) | 126, 1)
    frame.writeUInt16BE(length, 2)
    offset = 4
  } else {
    frame.writeUInt8((mask ? 0x80 : 0) | 127, 1)
    frame.writeBigUInt64BE(BigInt(length), 2)
    offset = 10
  }
  if (mask) {
    const key = randomBytes(4)
    key.copy(frame, offset)
    offset += 4
    for (let index = 0; index < length; index += 1) {
      frame[offset + index] = payload[index] ^ key[index % 4]
    }
  } else {
    payload.copy(frame, offset)
  }
  return frame
}

/**
 * Reassembles WebSocket frames from a byte stream.
 */
export class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  /**
   * @param {Buffer} chunk - Newly received bytes.
   * @returns {{opcode: number, payload: Buffer}[]} complete messages.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages = []
    for (;;) {
      if (this.buffer.length < 2) break
      const first = this.buffer.readUInt8(0)
      const second = this.buffer.readUInt8(1)
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < offset + 2) break
        length = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break
        const big = this.buffer.readBigUInt64BE(offset)
        if (big > BigInt(MAX_MESSAGE)) throw new MeshError('ws/frame', 'WebSocket message exceeds the size limit')
        length = Number(big)
        offset += 8
      }
      let maskKey
      if (masked) {
        if (this.buffer.length < offset + 4) break
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) break
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (maskKey !== undefined) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
      }
      this.buffer = this.buffer.subarray(offset + length)
      messages.push({ opcode, fin, payload })
    }
    return messages
  }
}

/**
 * A bidirectional WebSocket connection exposed as a duplex byte stream.
 * @augments Duplex
 */
export class WebSocketDuplex extends Duplex {
  /**
   * @param {import('node:net').Socket} socket - Raw socket after the upgrade.
   * @param {{mask: boolean, maxPayload?: number}} options - Role facts.
   */
  constructor(socket, options) {
    super()
    this.socket = socket
    this.mask = options.mask
    this.maxPayload = options.maxPayload ?? MAX_MESSAGE
    this.parser = new FrameParser()
    this.fragments = []
    this.fragmentOpcode = undefined
    this.isClosed = false
    // A dead carrier is routine here too; an unhandled `error` event would kill
    // the process rather than just this connection.
    this.on('error', () => {})
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => this.onSocketClose())
  }

  /**
   * @param {Buffer} chunk - Payload to send as one binary message.
   * @param {string} _encoding - Ignored.
   * @param {(error?: Error|null) => void} callback - Write completion.
   * @returns {void}
   */
  _write(chunk, _encoding, callback) {
    // A dead carrier drops instead of erroring: the readable side already
    // reports the loss once through 'close', and a relay forwards to peers that
    // may vanish between the lookup and the write.
    if (this.isClosed || this.socket.destroyed) {
      callback()
      return
    }
    if (this.socket.write(encodeFrame(OP_BINARY, chunk, this.mask))) callback()
    else this.socket.once('drain', () => callback())
  }

  /**
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _final(callback) {
    this.close()
    callback()
  }

  /**
   * @param {Error|null} error - Destruction cause.
   * @param {(error?: Error|null) => void} callback - Completion.
   * @returns {void}
   */
  _destroy(error, callback) {
    this.close()
    callback(error)
  }

  /** @returns {void} */
  _read() {
    this.socket.resume()
  }

  /** Send a close frame and drop the socket. */
  close() {
    if (this.isClosed) return
    this.isClosed = true
    try {
      this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0), this.mask))
    } catch {
      /* the socket may already be gone */
    }
    this.socket.end()
  }

  /**
   * Keep the relay's idle link alive across NAT timeouts and proxies.
   * @returns {void}
   */
  ping() {
    if (this.isClosed) return
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0), this.mask))
    } catch {
      /* the socket may already be gone */
    }
  }

  onSocketClose() {
    if (this.isClosed) {
      this.push(null)
      return
    }
    this.isClosed = true
    this.push(null)
  }

  /**
   * @param {Buffer} chunk - Raw socket bytes.
   * @returns {void}
   */
  onData(chunk) {
    let frames
    try {
      frames = this.parser.push(chunk)
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case OP_PING:
          this.socket.write(encodeFrame(OP_PONG, frame.payload, this.mask))
          break
        case OP_PONG:
          break
        case OP_CLOSE:
          this.close()
          this.push(null)
          return
        case OP_CONTINUATION:
          this.fragments.push(frame.payload)
          if (frame.fin) this.flushFragments()
          break
        case OP_BINARY:
        case OP_TEXT:
          if (frame.fin && this.fragments.length === 0) {
            this.push(frame.payload)
          } else {
            this.fragmentOpcode = frame.opcode
            this.fragments.push(frame.payload)
            if (frame.fin) this.flushFragments()
          }
          break
        default:
          this.destroy(new MeshError('ws/frame', `unsupported WebSocket opcode ${frame.opcode}`))
          return
      }
    }
  }

  flushFragments() {
    const message = Buffer.concat(this.fragments)
    this.fragments = []
    this.fragmentOpcode = undefined
    this.push(message)
  }
}

/**
 * Upgrade an incoming HTTP request, if it is a well-formed WebSocket handshake.
 * @param {import('node:http').IncomingMessage} request - Upgrade request.
 * @param {import('node:net').Socket} socket - Raw socket.
 * @param {Buffer} head - Bytes already read past the request.
 * @param {{maxPayload?: number}} [options] - Frame limits.
 * @returns {WebSocketDuplex|undefined} the connection, or undefined when the handshake is invalid.
 */
export function upgradeRequest(request, socket, head, options) {
  const key = request.headers['sec-websocket-key']
  const version = request.headers['sec-websocket-version']
  if (typeof key !== 'string' || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return undefined
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  const duplex = new WebSocketDuplex(socket, { mask: false, ...options })
  if (head.length > 0) duplex.onData(head)
  return duplex
}

/**
 * Attach a WebSocket endpoint to an HTTP server.
 * @param {import('node:http').Server} server - Server to attach to.
 * @param {{path?: string, onConnection: (duplex: WebSocketDuplex, request: import('node:http').IncomingMessage) => void}} options - Endpoint options.
 * @returns {() => void} detach function.
 */
export function attachWebSocketServer(server, options) {
  const path = options.path ?? '/'
  const listener = (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://relay.invalid').pathname
    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const duplex = upgradeRequest(request, socket, head)
    if (duplex !== undefined) options.onConnection(duplex, request)
  }
  server.on('upgrade', listener)
  return () => server.off('upgrade', listener)
}

/**
 * Open a client WebSocket, over TLS for `wss:` and plain TCP for `ws:`.
 * @param {string|URL} url - Endpoint URL, including any path.
 * @param {{headers?: Record<string, string>, timeoutMs?: number, ca?: string|Buffer|Array<string|Buffer>, rejectUnauthorized?: boolean}} [options] - Connection options. `ca` supplies a private CA (a relay behind a self-signed certificate); leave `rejectUnauthorized` unset to keep real certificate validation on.
 * @returns {Promise<WebSocketDuplex>} the upgraded connection.
 */
export function connectWebSocket(url, options = {}) {
  const target = url instanceof URL ? url : new URL(url)
  const secure = target.protocol === 'wss:'
  if (!secure && target.protocol !== 'ws:') {
    return Promise.reject(new MeshError('ws/url', `unsupported WebSocket scheme ${target.protocol}`))
  }
  const key = randomBytes(16).toString('base64')
  const headers = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...options.headers,
  }
  const request = (secure ? https : http).request({
    hostname: target.hostname,
    port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      request.destroy(new MeshError('ws/timeout', `WebSocket handshake to ${target.host} timed out`))
    }, options.timeoutMs ?? 15000)
    timeout.unref?.()
    request.on('upgrade', (response, socket, head) => {
      clearTimeout(timeout)
      const accept = response.headers['sec-websocket-accept']
      if (accept !== computeAccept(key)) {
        socket.destroy()
        reject(new MeshError('ws/handshake', 'relay answered an invalid Sec-WebSocket-Accept'))
        return
      }
      socket.setNoDelay(true)
      // The relay pings every 25s, but keepalive covers a proxy or NAT that
      // drops an idle mapping without telling either end.
      socket.setKeepAlive(true, 30000)
      const duplex = new WebSocketDuplex(socket, { mask: true })
      if (head.length > 0) duplex.onData(head)
      resolve(duplex)
    })
    request.on('response', (response) => {
      clearTimeout(timeout)
      const status = response.statusCode ?? 0
      response.resume()
      reject(new MeshError('ws/handshake', `relay refused the upgrade with HTTP ${status}`))
    })
    request.on('error', (error) => {
      clearTimeout(timeout)
      reject(error instanceof MeshError ? error : new MeshError('ws/transport', `WebSocket connect failed: ${error.message}`))
    })
    request.end()
  })
}

export { OP_BINARY, OP_TEXT, OP_PING, OP_PONG, OP_CLOSE, MAX_MESSAGE }
