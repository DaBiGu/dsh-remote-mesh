/**
 * Cryptography for the remote mesh.
 *
 * Every machine holds one static X25519 identity and one shared cluster secret.
 * Two machines that want to talk run a handshake over whatever carrier they
 * already have: a direct TCP socket, or a virtual circuit through the public
 * relay. The session keys mix four independent secrets:
 *
 *   - ephemeral x ephemeral ECDH -> forward secrecy: a later key compromise
 *                                   does not decrypt recorded traffic
 *   - static    x static    ECDH -> peer authentication
 *   - ephemeral x static (both ways) -> key-compromise impersonation resistance
 *   - the shared cluster secret  -> membership: a machine that was never
 *                                   enrolled cannot derive the session keys,
 *                                   and cannot forge either handshake record
 *
 * The relay on the public server only ever forwards ciphertext. It sees peer
 * ids, stream ids, frame sizes and timing, and nothing else: traffic content,
 * tunnel targets and DSH launch tokens all travel inside the AEAD envelope.
 * @module dsh-remote-mesh/core/crypto
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { MeshError, fromB64, isRecord, toB64 } from './util.js'

/** SPKI DER prefix preceding the raw 32-byte X25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
/** PKCS8 DER prefix preceding the raw 32-byte X25519 private key. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** Length of an X25519 key in bytes. */
export const KEY_LEN = 32
/** Length of the handshake nonce in bytes. */
export const NONCE_LEN = 32
/** Length of the AES-GCM authentication tag in bytes. */
export const TAG_LEN = 16
/** AEAD associated data, so a frame cannot be replayed into another protocol. */
const AAD = Buffer.from('dsh-remote-mesh/link/v1')

/**
 * Wrap a raw 32-byte X25519 public key as a KeyObject.
 * @param {Buffer} raw - Raw public key bytes.
 * @returns {import('node:crypto').KeyObject} the key object.
 */
export function publicFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== KEY_LEN) throw new MeshError('crypto/key', 'x25519 public keys are 32 bytes')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/**
 * Wrap a raw 32-byte X25519 private key as a KeyObject.
 * @param {Buffer} raw - Raw private key bytes.
 * @returns {import('node:crypto').KeyObject} the key object.
 */
export function privateFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== KEY_LEN) throw new MeshError('crypto/key', 'x25519 private keys are 32 bytes')
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

/**
 * @param {import('node:crypto').KeyObject} key - Public key object.
 * @returns {Buffer} the raw 32-byte public key.
 */
export function rawFromPublic(key) {
  return Buffer.from(key.export({ format: 'der', type: 'spki' })).subarray(-KEY_LEN)
}

/**
 * @param {import('node:crypto').KeyObject} key - Private key object.
 * @returns {Buffer} the raw 32-byte private key.
 */
export function rawFromPrivate(key) {
  return Buffer.from(key.export({ format: 'der', type: 'pkcs8' })).subarray(-KEY_LEN)
}

/**
 * Mint a fresh X25519 identity.
 * @returns {{privateKey: Buffer, publicKey: Buffer}} raw key material.
 */
export function generateIdentity() {
  const pair = generateKeyPairSync('x25519')
  return { privateKey: rawFromPrivate(pair.privateKey), publicKey: rawFromPublic(pair.publicKey) }
}

/**
 * Derive a subkey with HKDF-SHA256.
 * @param {Buffer} ikm - Input key material.
 * @param {Buffer|string} salt - HKDF salt.
 * @param {string} info - Domain separation label.
 * @param {number} [length] - Output length in bytes.
 * @returns {Buffer} the derived key.
 */
export function hkdf(ikm, salt, info, length = KEY_LEN) {
  const saltBuffer = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : salt
  return Buffer.from(hkdfSync('sha256', ikm, saltBuffer, Buffer.from(info, 'utf8'), length))
}

/**
 * @param {Buffer|string} key - MAC key.
 * @param {Buffer|string} data - Message to authenticate.
 * @returns {Buffer} HMAC-SHA256 tag.
 */
export function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/**
 * Constant-time equality over two byte strings.
 * @param {Buffer|Uint8Array|string} a - Left value.
 * @param {Buffer|Uint8Array|string} b - Right value.
 * @returns {boolean} whether both are byte-identical.
 */
export function bytesEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * One directional AEAD writer: a fixed key plus a monotonic counter nonce.
 * Distinct keys per direction make nonce reuse impossible by construction.
 */
export class Sealer {
  /**
   * @param {Buffer} key - 32-byte AEAD key.
   */
  constructor(key) {
    this.key = key
    this.counter = 0n
  }

  /**
   * @param {Buffer} plaintext - Payload to protect.
   * @returns {Buffer} ciphertext with the 16-byte tag appended.
   */
  seal(plaintext) {
    const iv = Buffer.alloc(12)
    iv.writeBigUInt64BE(this.counter, 4)
    this.counter += 1n
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(AAD)
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  }
}

/** One directional AEAD reader, the mirror of {@link Sealer}. */
export class Opener {
  /**
   * @param {Buffer} key - 32-byte AEAD key.
   */
  constructor(key) {
    this.key = key
    this.counter = 0n
  }

  /**
   * @param {Buffer} payload - Ciphertext with trailing tag.
   * @returns {Buffer} the recovered plaintext.
   * @throws {MeshError} when the tag does not verify. A failed open does not
   *   consume the counter, so the reader is left exactly where it was.
   */
  open(payload) {
    if (payload.length < TAG_LEN) throw new MeshError('link/frame', 'sealed frame is shorter than its tag')
    const iv = Buffer.alloc(12)
    iv.writeBigUInt64BE(this.counter, 4)
    const body = payload.subarray(0, payload.length - TAG_LEN)
    const tag = payload.subarray(payload.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    let plaintext
    try {
      plaintext = Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
      throw new MeshError('link/auth', 'sealed frame failed authentication')
    }
    this.counter += 1n
    return plaintext
  }
}

/**
 * The cluster authentication key, derived once from the shared secret.
 * @param {Buffer} clusterKey - Raw cluster secret.
 * @returns {Buffer} the MAC key used by both handshake records.
 */
export function authKey(clusterKey) {
  return hkdf(clusterKey, 'dsh-remote-mesh/cluster-auth', 'handshake-mac/v1')
}

function transcript(record) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      role: record.role,
      id: record.id,
      spk: record.spk,
      eph: record.eph,
      nonce: record.nonce,
      ...(record.to === undefined ? {} : { to: record.to, rn: record.rn }),
    }),
    'utf8',
  )
}

/**
 * Build the initiator's HELLO record.
 * @param {{machineId: string, identity: {privateKey: Buffer, publicKey: Buffer}, clusterKey: Buffer}} options - Local material.
 * @returns {{record: Record<string, string|number>, state: {eph: {privateKey: Buffer, publicKey: Buffer}, nonce: Buffer, machineId: string, staticPublicKey: Buffer, staticPrivateKey: Buffer}}} the wire record and retained state.
 */
export function createHello({ machineId, identity, clusterKey }) {
  const eph = generateIdentity()
  const nonce = randomBytes(NONCE_LEN)
  const record = {
    v: 1,
    role: 'hello',
    id: machineId,
    spk: toB64(identity.publicKey),
    eph: toB64(eph.publicKey),
    nonce: toB64(nonce),
  }
  return {
    record: { ...record, mac: toB64(hmac(authKey(clusterKey), transcript(record))) },
    state: {
      eph,
      nonce,
      machineId,
      staticPublicKey: identity.publicKey,
      staticPrivateKey: identity.privateKey,
    },
  }
}

/**
 * Verify a peer's HELLO and answer with ACK, deriving the session keys.
 * @param {unknown} input - Received HELLO record.
 * @param {{machineId: string, identity: {privateKey: Buffer, publicKey: Buffer}, clusterKey: Buffer}} options - Local material.
 * @returns {{record: Record<string, string|number>, keys: {clientToServer: Buffer, serverToClient: Buffer}, peerId: string, peerStaticKey: Buffer}} ACK to send, derived keys and the peer identity.
 */
export function acceptHello(input, { machineId, identity, clusterKey }) {
  const hello = parseRecord(input, 'hello')
  const key = authKey(clusterKey)
  const expected = hmac(key, transcript({ ...hello.wire, mac: undefined }))
  if (!bytesEqual(expected, hello.mac)) throw new MeshError('link/auth', 'peer HELLO failed cluster authentication')

  const eph = generateIdentity()
  const nonce = randomBytes(NONCE_LEN)
  const record = {
    v: 1,
    role: 'ack',
    id: machineId,
    spk: toB64(identity.publicKey),
    eph: toB64(eph.publicKey),
    nonce: toB64(nonce),
    to: hello.id,
    rn: toB64(hello.nonce),
  }
  const secrets = computeSecrets({
    role: 'responder',
    myStatic: identity,
    peerStaticPublic: hello.staticKey,
    myEph: eph,
    peerEphPublic: hello.ephKey,
  })
  const salt = Buffer.concat([hello.nonce, nonce])
  return {
    record: { ...record, mac: toB64(hmac(key, transcript(record))) },
    keys: deriveKeys(secrets, salt, clusterKey, hello.id, machineId),
    peerId: hello.id,
    peerStaticKey: hello.staticKey,
  }
}

/**
 * Verify the responder's ACK and derive the matching session keys.
 * @param {unknown} input - Received ACK record.
 * @param {Record<string, any>} state - Retained HELLO state.
 * @param {{clusterKey: Buffer}} options - Cluster material.
 * @returns {{keys: {clientToServer: Buffer, serverToClient: Buffer}, peerId: string, peerStaticKey: Buffer}} derived keys and the peer identity.
 */
export function finishHello(input, state, { clusterKey }) {
  const ack = parseRecord(input, 'ack')
  const key = authKey(clusterKey)
  const expected = hmac(key, transcript({ ...ack.wire, mac: undefined }))
  if (!bytesEqual(expected, ack.mac)) throw new MeshError('link/auth', 'peer ACK failed cluster authentication')
  if (ack.wire.to !== state.machineId) throw new MeshError('link/auth', 'peer ACK answered a different machine')
  if (!bytesEqual(fromB64(String(ack.wire.rn)), state.nonce)) throw new MeshError('link/auth', 'peer ACK replayed a stale nonce')

  const secrets = computeSecrets({
    role: 'initiator',
    myStatic: { privateKey: state.staticPrivateKey, publicKey: state.staticPublicKey },
    peerStaticPublic: ack.staticKey,
    myEph: state.eph,
    peerEphPublic: ack.ephKey,
  })
  const salt = Buffer.concat([state.nonce, ack.nonce])
  return {
    keys: deriveKeys(secrets, salt, clusterKey, state.machineId, ack.id),
    peerId: ack.id,
    peerStaticKey: ack.staticKey,
  }
}

/**
 * Compute the four ECDH terms from one side's own private keys and the peer's
 * public keys. ECDH is symmetric, so both sides derive byte-identical material;
 * the fixed concatenation order is what keeps them in agreement.
 * @param {{role: 'initiator'|'responder', myStatic: {privateKey: Buffer, publicKey: Buffer}, peerStaticPublic: Buffer, myEph: {privateKey: Buffer, publicKey: Buffer}, peerEphPublic: Buffer}} sides - One side's key material.
 * @returns {Buffer} `ee || ss || es || se`.
 */
function computeSecrets({ role, myStatic, peerStaticPublic, myEph, peerEphPublic }) {
  const ecdh = (privateKey, publicKey) =>
    diffieHellman({ privateKey: privateFromRaw(privateKey), publicKey: publicFromRaw(publicKey) })
  // Both cross terms pair an ephemeral half with a static half. Each side holds
  // the private half of exactly one of them, so the two roles read the pairing
  // from opposite sides and land on the same two shared points.
  const ephemeralToStatic = role === 'initiator'
    ? ecdh(myEph.privateKey, peerStaticPublic)
    : ecdh(myStatic.privateKey, peerEphPublic)
  const staticToEphemeral = role === 'initiator'
    ? ecdh(myStatic.privateKey, peerEphPublic)
    : ecdh(myEph.privateKey, peerStaticPublic)
  return Buffer.concat([
    ecdh(myEph.privateKey, peerEphPublic),
    ecdh(myStatic.privateKey, peerStaticPublic),
    ephemeralToStatic,
    staticToEphemeral,
  ])
}

function deriveKeys(secrets, salt, clusterKey, initiatorId, responderId) {
  const ikm = Buffer.concat([secrets, clusterKey])
  return {
    clientToServer: hkdf(ikm, salt, 'dsh-remote-mesh/link/v1/c2s'),
    serverToClient: hkdf(ikm, salt, 'dsh-remote-mesh/link/v1/s2c'),
    transcriptHash: hkdf(ikm, salt, `dsh-remote-mesh/transcript/v1/${initiatorId}>${responderId}`),
  }
}

function parseRecord(input, role) {
  if (!isRecord(input) || input.v !== 1 || input.role !== role) {
    throw new MeshError('link/protocol', `expected a ${role.toUpperCase()} record`)
  }
  const id = input.id
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw new MeshError('link/protocol', 'peer id must be 1-64 characters of [A-Za-z0-9._-]')
  }
  const staticKey = decodeKey(input.spk, 'spk')
  const ephKey = decodeKey(input.eph, 'eph')
  const nonce = decodeKey(input.nonce, 'nonce', 8, 64)
  const mac = fromB64(requireText(input.mac, 'mac'))
  if (mac.length !== 32) throw new MeshError('link/protocol', 'handshake MAC must be 32 bytes')
  return { id, staticKey, ephKey, nonce, mac, wire: { ...input } }
}

function decodeKey(value, field, min = KEY_LEN, max = KEY_LEN) {
  const bytes = fromB64(requireText(value, field))
  if (bytes.length < min || bytes.length > max) {
    throw new MeshError('link/protocol', `${field} must be ${min}-${max} bytes`)
  }
  return bytes
}

function requireText(value, field) {
  if (typeof value !== 'string' || value === '') throw new MeshError('link/protocol', `field ${field} is missing`)
  return value
}
