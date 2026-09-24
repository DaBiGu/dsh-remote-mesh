/**
 * The relay wire protocol, shared by the relay server and every node client.
 *
 * A relay frame is one WebSocket binary message:
 * `[1-byte type][2-byte big-endian header length][UTF-8 JSON header][payload]`.
 *
 * The relay is deliberately blind. A frame's header names a peer and a circuit
 * and nothing else; every payload byte is already sealed by the two endpoints,
 * and tunnel targets, DSH launch tokens and conversation content never appear
 * in anything the relay can decode.
 * @module dsh-remote-mesh/core/relay-wire
 */
import { MeshError, isRecord } from './util.js'

/** Node -> relay: claim an identity. Header `{id}`. */
export const REGISTER = 1
/** Node -> relay: open a virtual circuit to another node. Header `{to, cid}`. */
export const OPEN = 2
/** Either direction: bytes for a circuit. Header `{cid}`. */
export const DATA = 3
/** Either direction: circuit finished. Header `{cid}`. */
export const CLOSE = 4
/** Relay -> node: a new inbound circuit arrived. Header `{from, cid}`. */
export const INCOMING = 5
/** Either direction: liveness. Header `{}`. */
export const PING = 6
/** Relay -> node: refusal. Header `{cid?, reason}`. */
export const ERROR = 7

const MAX_HEADER = 1024

/**
 * @param {number} type - Relay frame type.
 * @param {Record<string, unknown>} header - JSON header.
 * @param {Buffer} [payload] - Optional raw payload.
 * @returns {Buffer} the encoded frame.
 */
export function encodeRelayFrame(type, header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  if (json.length > MAX_HEADER) throw new MeshError('relay/frame', 'relay header exceeds the size limit')
  const frame = Buffer.allocUnsafe(3 + json.length + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt16BE(json.length, 1)
  json.copy(frame, 3)
  payload.copy(frame, 3 + json.length)
  return frame
}

/**
 * Reassembles relay frames from a WebSocket's message stream.
 */
export class RelayFrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  /**
   * @param {Buffer} chunk - One WebSocket binary message.
   * @returns {{type: number, header: Record<string, unknown>, payload: Buffer}[]} complete frames.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames = []
    for (;;) {
      if (this.buffer.length < 3) break
      const type = this.buffer.readUInt8(0)
      const headerLength = this.buffer.readUInt16BE(1)
      if (headerLength > MAX_HEADER) throw new MeshError('relay/frame', 'relay header exceeds the size limit')
      if (this.buffer.length < 3 + headerLength) break
      const header = JSON.parse(this.buffer.subarray(3, 3 + headerLength).toString('utf8'))
      if (!isRecord(header)) throw new MeshError('relay/frame', 'relay header is not a JSON object')
      // The remainder is ambiguous only because a WebSocket message may carry
      // exactly one relay frame; anything past the header is that frame's payload.
      const payload = Buffer.from(this.buffer.subarray(3 + headerLength))
      this.buffer = Buffer.alloc(0)
      frames.push({ type, header, payload })
    }
    return frames
  }
}

/**
 * @param {number} type - Wire type.
 * @returns {string} a human-readable name, for logs.
 */
export function relayTypeName(type) {
  switch (type) {
    case REGISTER: return 'register'
    case OPEN: return 'open'
    case DATA: return 'data'
    case CLOSE: return 'close'
    case INCOMING: return 'incoming'
    case PING: return 'ping'
    case ERROR: return 'error'
    default: return `unknown(${type})`
  }
}
