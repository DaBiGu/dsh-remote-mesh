/**
 * Direct checks for the mesh crypto core: identity round-trips, a handshake
 * both sides agree on, and authentication failures that must be refused.
 * Run with `node test/crypto.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  Sealer,
  Opener,
  acceptHello,
  bytesEqual,
  createHello,
  finishHello,
  generateIdentity,
  hkdf,
  publicFromRaw,
  rawFromPublic,
} from '../lib/core/crypto.js'
import { fromB64, toB64 } from '../lib/core/util.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

check('raw x25519 round-trips through DER wrapping', () => {
  const identity = generateIdentity()
  assert.equal(rawFromPublic(publicFromRaw(identity.publicKey)).toString('hex'), identity.publicKey.toString('hex'))
  assert.equal(identity.publicKey.length, 32)
  assert.equal(identity.privateKey.length, 32)
})

check('hkdf is deterministic and domain-separated', () => {
  const a = hkdf(Buffer.from('ikm'), 'salt', 'one')
  const b = hkdf(Buffer.from('ikm'), 'salt', 'two')
  assert.equal(a.length, 32)
  assert.notEqual(a.toString('hex'), b.toString('hex'))
  assert.equal(a.toString('hex'), hkdf(Buffer.from('ikm'), 'salt', 'one').toString('hex'))
})

check('both sides derive the same directional keys', () => {
  const clusterKey = Buffer.from('cluster-secret-0123456789abcdef')
  const alice = { machineId: 'alice', identity: generateIdentity(), clusterKey }
  const bob = { machineId: 'bob', identity: generateIdentity(), clusterKey }

  const { record: helloRecord, state } = createHello(alice)
  const { record: ackRecord, keys: bobKeys, peerId } = acceptHello(helloRecord, bob)
  const { keys: aliceKeys, peerId: peerIdAtAlice } = finishHello(ackRecord, state, { clusterKey })

  assert.equal(peerId, 'alice')
  assert.equal(peerIdAtAlice, 'bob')
  assert.equal(aliceKeys.clientToServer.toString('hex'), bobKeys.clientToServer.toString('hex'))
  assert.equal(aliceKeys.serverToClient.toString('hex'), bobKeys.serverToClient.toString('hex'))
  assert.notEqual(aliceKeys.clientToServer.toString('hex'), aliceKeys.serverToClient.toString('hex'))

  // Alice seals with c2s; Bob opens with c2s and replies with s2c.
  const fromAlice = new Sealer(aliceKeys.clientToServer).seal(Buffer.from('hello bob'))
  assert.equal(new Opener(bobKeys.clientToServer).open(fromAlice).toString(), 'hello bob')
  const fromBob = new Sealer(bobKeys.serverToClient).seal(Buffer.from('hello alice'))
  assert.equal(new Opener(aliceKeys.serverToClient).open(fromBob).toString(), 'hello alice')
})

check('a wrong cluster secret is refused', () => {
  const alice = { machineId: 'alice', identity: generateIdentity(), clusterKey: Buffer.from('secret-a') }
  const bob = { machineId: 'bob', identity: generateIdentity(), clusterKey: Buffer.from('secret-b') }
  const { record } = createHello(alice)
  assert.throws(() => acceptHello(record, bob), /cluster authentication/)
})

check('a tampered HELLO is refused', () => {
  const clusterKey = Buffer.from('shared')
  const alice = { machineId: 'alice', identity: generateIdentity(), clusterKey }
  const bob = { machineId: 'bob', identity: generateIdentity(), clusterKey }
  const { record } = createHello(alice)
  const forged = { ...record, id: 'mallory' }
  assert.throws(() => acceptHello(forged, bob), /cluster authentication/)
})

check('a replayed ACK nonce is refused', () => {
  const clusterKey = Buffer.from('shared')
  const alice = { machineId: 'alice', identity: generateIdentity(), clusterKey }
  const bob = { machineId: 'bob', identity: generateIdentity(), clusterKey }
  const carol = { machineId: 'carol', identity: generateIdentity(), clusterKey }
  const first = createHello(alice)
  const { record: ack } = acceptHello(first.record, bob)
  const second = createHello(carol)
  assert.throws(() => finishHello(ack, second.state, { clusterKey }), /different machine|stale nonce/)
})

check('a counter-based AEAD stream rejects reordering', () => {
  const key = Buffer.alloc(32, 7)
  const sealer = new Sealer(key)
  const first = sealer.seal(Buffer.from('one'))
  const second = sealer.seal(Buffer.from('two'))
  const opener = new Opener(key)
  // The second frame arrives first: it must be refused, and the refusal must
  // leave the reader where it was so the honest frame still opens.
  assert.throws(() => opener.open(second), /failed authentication/)
  assert.equal(opener.open(first).toString(), 'one')
  assert.equal(opener.open(second).toString(), 'two')
})

check('bytesEqual is length-safe', () => {
  assert.equal(bytesEqual(Buffer.from('abc'), Buffer.from('abc')), true)
  assert.equal(bytesEqual(Buffer.from('abc'), Buffer.from('abcd')), false)
  const original = Buffer.from([0x00, 0xff, 0x7f, 0x80])
  assert.equal(bytesEqual(fromB64(toB64(original)), original), true)
})

process.stdout.write(`\n${passed} checks passed\n`)
