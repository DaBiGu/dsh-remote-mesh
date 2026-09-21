/**
 * Shared primitives for the remote mesh: byte helpers, identifiers, bounded
 * queues and the error vocabulary the transports and RPC layers agree on.
 * @module dsh-remote-workspaces/core/util
 */
import { randomBytes, randomUUID } from 'node:crypto'

/** Protocol version carried by every link and relay handshake. */
export const PROTOCOL_VERSION = 1

/** Reserved in-band target that addresses the peer's mesh API instead of a TCP port. */
export const API_TARGET = '#api'

/** Reserved in-band target prefix for the peer's own loopback TCP ports. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])

/**
 * One mesh failure with a stable machine-readable code.
 */
export class MeshError extends Error {
  /**
   * @param {string} code - Stable failure code (for example `link/auth`).
   * @param {string} message - Human-readable detail.
   * @param {Record<string, unknown>} [details] - Optional structured detail.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'MeshError'
    this.code = code
    this.details = details ?? {}
  }
}

/**
 * @param {Buffer|Uint8Array|string} value - Bytes or text to encode.
 * @returns {string} base64url spelling without padding.
 */
export function toB64(value) {
  return Buffer.from(value).toString('base64url')
}

/**
 * @param {string} value - base64url spelling without padding.
 * @returns {Buffer} the decoded bytes.
 */
export function fromB64(value) {
  return Buffer.from(value, 'base64url')
}

/**
 * @param {number} bytes - Count of random bytes.
 * @returns {Buffer} cryptographically random bytes.
 */
export function random(bytes) {
  return randomBytes(bytes)
}

/**
 * @returns {string} a fresh lowercase uuid v4.
 */
export function newId() {
  return randomUUID()
}

/**
 * @param {unknown} value - Candidate text.
 * @returns {boolean} whether the value is a non-empty string.
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * @param {unknown} value - Candidate value.
 * @returns {boolean} whether the value is a plain record.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clamp a port-like number into the legal TCP range.
 * @param {unknown} value - Candidate port.
 * @returns {number|undefined} the port, or undefined when out of range.
 */
export function asPort(value) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/**
 * Parse and police an in-band tunnel target: either the reserved API target or
 * a loopback TCP endpoint. Anything else is refused, so a peer can never make
 * this machine dial out to a third host.
 * @param {unknown} target - Target string from the wire.
 * @returns {{kind: 'api'} | {kind: 'tcp', host: string, port: number}} parsed target.
 * @throws {MeshError} when the target is not an allowed shape.
 */
export function parseTarget(target) {
  if (target === API_TARGET) return { kind: 'api' }
  if (typeof target !== 'string' || target.length === 0 || target.length > 128) {
    throw new MeshError('mux/target', 'tunnel target must be a short string')
  }
  const match = /^(127\.0\.0\.1|\[::1\]|::1|localhost):(\d{1,5})$/.exec(target)
  if (match === null) {
    throw new MeshError('mux/target', `tunnel target ${JSON.stringify(target)} is not a loopback endpoint`)
  }
  const port = asPort(Number(match[2]))
  if (port === undefined) throw new MeshError('mux/target', `tunnel target port is out of range in ${JSON.stringify(target)}`)
  const host = match[1] === '[::1]' || match[1] === '::1' ? '::1' : match[1]
  return { kind: 'tcp', host, port }
}

/**
 * Render a loopback TCP target back into its canonical wire spelling.
 * @param {string} host - Loopback host literal.
 * @param {number} port - TCP port.
 * @returns {string} canonical target string.
 */
export function tcpTarget(host, port) {
  const literal = host === '::1' ? '[::1]' : host
  return `${literal}:${port}`
}

/**
 * Race a promise against a deadline.
 * @template T
 * @param {Promise<T>} promise - Work to bound.
 * @param {number} ms - Deadline in milliseconds.
 * @param {string} what - Description used in the timeout message.
 * @returns {Promise<T>} the settled value.
 */
export function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new MeshError('timeout', `${what} did not settle within ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Sleep for a bounded interval.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
export function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * A monotonic counter pair used to build per-direction AEAD nonces.
 * A distinct key per direction makes nonce reuse impossible by construction.
 */
export class Counter {
  constructor() {
    this.value = 0n
  }

  /**
   * @returns {Buffer} the next 8-byte big-endian counter value.
   */
  next() {
    const out = Buffer.alloc(8)
    out.writeBigUInt64BE(this.value)
    this.value += 1n
    return out
  }
}
