/**
 * End-to-end checks for the mesh: real sockets, real handshakes, real tunnels.
 *
 * Covered here:
 *   - two nodes establish an encrypted link over a direct TCP carrier
 *   - a stream to a loopback `host:port` on the peer carries a real HTTP exchange
 *   - many concurrent streams stay independent
 *   - the in-band `#api` target reaches the peer's handler
 *   - a node with the wrong cluster secret cannot connect
 *   - a peer cannot be made to dial a non-loopback host
 *   - the same traffic works through the relay, and the relay only ever sees
 *     ciphertext
 * Run with `node test/mesh.test.mjs`.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { attachWebSocketServer } from '../lib/core/ws.js'
import { Mesh } from '../lib/core/mesh.js'
import { generateIdentity } from '../lib/core/crypto.js'
import { CLOSE, DATA, ERROR, INCOMING, OPEN, PING, REGISTER, RelayFrameParser, encodeRelayFrame } from '../lib/core/relay-wire.js'
import { verifyRelayToken } from '../lib/core/transport.js'
import { API_TARGET, delay } from '../lib/core/util.js'

const CLUSTER_KEY = Buffer.from('a-shared-cluster-secret-for-tests')
const RELAY_SECRET = 'relay-secret-for-tests-0123456789'

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

/**
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, hits: number}>} a plain HTTP server to tunnel to.
 */
function startTarget() {
  const state = { hits: 0 }
  const server = http.createServer((request, response) => {
    state.hits += 1
    const url = new URL(request.url, 'http://target.invalid')
    if (url.pathname === '/big') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      const chunk = Buffer.alloc(64 * 1024, 0x41)
      for (let index = 0; index < 64; index += 1) response.write(chunk)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ path: url.pathname, host: request.headers.host, hits: state.hits }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((done) => server.close(() => done())),
        get hits() {
          return state.hits
        },
      })
    })
  })
}

/**
 * Read an HTTP response off a raw duplex tunnel. The request asks for
 * `Connection: close`, so collecting until the tunnel half-closes is always
 * correct regardless of whether the target framed the body with a length or
 * with chunked encoding.
 * @param {import('node:stream').Duplex} stream - Tunnel stream.
 * @param {string} requestText - Raw request to send.
 * @returns {Promise<{status: number, headers: string, body: Buffer}>} the parsed response.
 */
function rawHttp(stream, requestText) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      const split = buffer.indexOf('\r\n\r\n')
      if (split === -1) {
        reject(new Error(`no HTTP response head in ${buffer.length} bytes: ${buffer.subarray(0, 200).toString('latin1')}`))
        return
      }
      const head = buffer.subarray(0, split).toString('latin1')
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1] ?? 0)
      let body = buffer.subarray(split + 4)
      if (/transfer-encoding: *chunked/i.test(head)) body = dechunk(body)
      stream.destroy()
      resolve({ status, headers: head, body })
    }
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split === -1) return
      const head = buffer.subarray(0, split).toString('latin1')
      const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? -1)
      if (length >= 0 && buffer.length >= split + 4 + length) finish()
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', reject)
    stream.write(Buffer.from(requestText, 'latin1'))
  })
}

/**
 * @param {Buffer} body - Chunked transfer body.
 * @returns {Buffer} the reassembled entity body.
 */
function dechunk(body) {
  const parts = []
  let offset = 0
  for (;;) {
    const end = body.indexOf('\r\n', offset)
    if (end === -1) break
    const size = Number.parseInt(body.subarray(offset, end).toString('latin1').split(';')[0], 16)
    if (!Number.isFinite(size) || size === 0) break
    parts.push(body.subarray(end + 2, end + 2 + size))
    offset = end + 2 + size + 2
  }
  return Buffer.concat(parts)
}

/**
 * @param {Record<string, any>} overrides - Mesh options to override.
 * @returns {Mesh} a mesh node.
 */
function makeNode(overrides) {
  return new Mesh({
    machineId: 'node',
    machineName: 'node',
    identity: generateIdentity(),
    clusterKey: CLUSTER_KEY,
    listenHost: '127.0.0.1',
    listenPort: 0,
    log: () => {},
    ...overrides,
  })
}

/**
 * Wait for a peer to report online.
 * @param {Mesh} mesh - Node to watch.
 * @param {string} peerId - Peer to wait for.
 * @param {number} timeoutMs - Deadline.
 * @returns {Promise<void>} resolves when online.
 */
async function waitOnline(mesh, peerId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const peer = mesh.snapshotPeers().find((entry) => entry.id === peerId)
    if (peer?.status === 'online') return
    await delay(50)
  }
  const peer = mesh.snapshotPeers().find((entry) => entry.id === peerId)
  throw new Error(`peer ${peerId} never came online: ${JSON.stringify(peer)}`)
}

const target = await startTarget()
const targetSpec = `127.0.0.1:${target.port}`

const alice = makeNode({
  machineId: 'alice',
  machineName: 'Alice laptop',
  apiHandler: async (request, peerId) => ({ op: request.op, payload: request.payload, servedBy: 'alice', from: peerId }),
})
const bob = makeNode({
  machineId: 'bob',
  machineName: 'Bob desktop',
  apiHandler: async (request, peerId) => ({ op: request.op, payload: request.payload, servedBy: 'bob', from: peerId }),
})

await alice.start()
await bob.start()
await alice.setPeers([{ id: 'bob', name: 'Bob desktop', transport: 'direct', host: '127.0.0.1', port: bob.boundPort, enabled: true }])
await bob.setPeers([{ id: 'alice', name: 'Alice laptop', transport: 'direct', host: '127.0.0.1', port: alice.boundPort, enabled: true }])

await check('two nodes establish a link over a direct TCP carrier', async () => {
  await waitOnline(alice, 'bob')
  await waitOnline(bob, 'alice')
})

await check('a tunnel carries a real HTTP exchange to a loopback port on the peer', async () => {
  const stream = await alice.stream('bob', targetSpec)
  const response = await rawHttp(stream, `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: close\r\n\r\n`)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body.toString('utf8'))
  assert.equal(body.path, '/hello')
  assert.equal(body.host, `127.0.0.1:${target.port}`)
})

await check('concurrent streams stay independent', async () => {
  const responses = await Promise.all(
    Array.from({ length: 24 }, async (_unused, index) => {
      const stream = await alice.stream('bob', targetSpec)
      const response = await rawHttp(stream, `GET /n${index} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`)
      return JSON.parse(response.body.toString('utf8')).path
    }),
  )
  assert.deepEqual(responses, Array.from({ length: 24 }, (_unused, index) => `/n${index}`))
})

await check('a large payload crosses the tunnel intact', async () => {
  const stream = await alice.stream('bob', targetSpec)
  const response = await rawHttp(stream, `GET /big HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`)
  assert.equal(response.status, 200)
  assert.equal(response.body.length, 64 * 1024 * 64)
  assert.equal(response.body[0], 0x41)
  assert.equal(response.body[response.body.length - 1], 0x41)
})

await check('a tunnel to a port with no listener is refused with a reason', async () => {
  // The most likely reason a mapped page is blank, and it must arrive as a
  // reason rather than as a reset ten seconds later.
  const dead = net.createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))
  let refused
  try {
    await alice.stream('bob', `127.0.0.1:${deadPort}`, { timeoutMs: 8000 })
  } catch (error) {
    refused = error.message
  }
  assert.match(String(refused), /没有任何服务在监听/)
})

await check('the in-band API target reaches the peer handler', async () => {
  const answer = await alice.call('bob', 'snapshot', { want: 'workspaces' })
  assert.equal(answer.servedBy, 'bob')
  assert.equal(answer.op, 'snapshot')
  assert.equal(answer.from, 'alice')
  assert.deepEqual(answer.payload, { want: 'workspaces' })
})

await check('a peer vanishing mid-flight never reaches the process as a crash', async () => {
  // Regression guard for the worst failure this mesh can have. A peer that
  // resets its socket is routine — sleep, reboot, lost network — and an
  // unhandled `error` event on a link used to take the whole Harness host down
  // with it. If that regresses, this test process dies instead of failing.
  await waitOnline(alice, 'bob')
  for (let round = 0; round < 4; round += 1) {
    const alicePeer = alice.peers.get('bob')
    const bobPeer = bob.peers.get('alice')
    for (const peer of [alicePeer, bobPeer]) {
      peer?.mux?.destroy(new Error(`simulated peer reset ${round}`))
      if (peer?.link !== undefined && !peer.link.closed) peer.link.destroy()
    }
    await delay(120)
  }
  await delay(700)
  for (const [from, to] of [[alice, 'bob'], [bob, 'alice']]) {
    const stream = await from.stream(to, targetSpec)
    const response = await rawHttp(stream, 'GET /after-reset HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n')
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body.toString('utf8')).path, '/after-reset')
  }
})

await check('a node with the wrong cluster secret cannot connect', async () => {
  const mallory = makeNode({
    machineId: 'mallory',
    machineName: 'Mallory',
    clusterKey: Buffer.from('the-wrong-cluster-secret-for-tests'),
  })
  await mallory.start()
  await mallory.setPeers([{ id: 'bob', transport: 'direct', host: '127.0.0.1', port: bob.boundPort, enabled: true }])
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const peer = mallory.snapshotPeers()[0]
    if (peer.status === 'offline' && /authentication/.test(peer.error ?? '')) break
    await delay(50)
  }
  const peer = mallory.snapshotPeers()[0]
  assert.equal(peer.status, 'offline')
  assert.match(String(peer.error), /authentication/)
  await mallory.stop()
})

await check('a peer cannot make this machine dial a non-loopback host', async () => {
  let refused
  const proxy = makeNode({
    machineId: 'proxy',
    machineName: 'Proxy',
    onInboundTcp: () => true,
  })
  await proxy.start()
  await proxy.setPeers([{ id: 'alice', transport: 'direct', host: '127.0.0.1', port: alice.boundPort, enabled: true }])
  await alice.setPeers([
    { id: 'bob', name: 'Bob desktop', transport: 'direct', host: '127.0.0.1', port: bob.boundPort, enabled: true },
    { id: 'proxy', name: 'Proxy', transport: 'direct', host: '127.0.0.1', port: proxy.boundPort, enabled: true },
  ])
  await waitOnline(alice, 'proxy')
  try {
    await alice.stream('proxy', 'example.com:80')
  } catch (error) {
    refused = error.message
  }
  assert.match(String(refused), /not a loopback endpoint/)
  await proxy.stop()
  await alice.setPeers([{ id: 'bob', name: 'Bob desktop', transport: 'direct', host: '127.0.0.1', port: bob.boundPort, enabled: true }])
})

// ---------------------------------------------------------------------------
// Relay carrier
// ---------------------------------------------------------------------------

/** @type {Buffer[]} */
const relayedPayloads = []

/**
 * Start an in-process relay that records every DATA payload it forwards, so the
 * test can prove the relay never sees plaintext.
 * @returns {Promise<{url: string, close: () => Promise<void>, nodes: () => number}>} the relay.
 */
function startRelay() {
  const nodes = new Map()
  const circuits = new Map()
  const server = http.createServer((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  attachWebSocketServer(server, {
    path: '/relay',
    onConnection: (ws) => {
      const parser = new RelayFrameParser()
      let identity
      const send = (type, header, payload) => {
        if (ws.destroyed || ws.isClosed) return
        ws.write(encodeRelayFrame(type, header, payload))
      }
      const forward = (socket, type, header, payload) => {
        if (socket === undefined || socket.destroyed || socket.isClosed) return false
        socket.write(encodeRelayFrame(type, header, payload))
        return true
      }
      ws.on('error', () => {
        /* the close handler owns cleanup */
      })
      ws.on('data', (chunk) => {
        for (const frame of parser.push(chunk)) {
          if (frame.type === REGISTER) {
            const id = String(frame.header.id)
            if (!verifyRelayToken(RELAY_SECRET, id, frame.header.token)) {
              send(ERROR, { reason: 'registration refused' })
              ws.destroy()
              return
            }
            identity = id
            nodes.set(id, ws)
            send(PING, {})
            return
          }
          if (!identity) return
          if (frame.type === OPEN) {
            const to = String(frame.header.to)
            const cid = Number(frame.header.cid)
            const target = nodes.get(to)
            if (target === undefined) {
              send(ERROR, { cid, reason: `node ${to} offline` })
              return
            }
            circuits.set(cid, { from: identity, to })
            forward(target, INCOMING, { from: identity, cid })
            send(OPEN, { cid })
            return
          }
          if (frame.type === DATA) {
            const cid = Number(frame.header.cid)
            const circuit = circuits.get(cid)
            if (circuit === undefined) return
            relayedPayloads.push(frame.payload)
            const other = circuit.from === identity ? circuit.to : circuit.from
            forward(nodes.get(other), DATA, { cid }, frame.payload)
            return
          }
          if (frame.type === CLOSE) {
            const cid = Number(frame.header.cid)
            const circuit = circuits.get(cid)
            if (circuit === undefined) return
            circuits.delete(cid)
            const other = circuit.from === identity ? circuit.to : circuit.from
            forward(nodes.get(other), CLOSE, { cid })
          }
        }
      })
      ws.on('close', () => {
        if (identity !== undefined && nodes.get(identity) === ws) nodes.delete(identity)
      })
    },
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}/relay`,
        close: () => new Promise((done) => server.close(() => done())),
        nodes: () => nodes.size,
      })
    })
  })
}

const relay = await startRelay()
const carol = makeNode({
  machineId: 'carol',
  machineName: 'Carol desktop',
  relay: { url: relay.url, secret: RELAY_SECRET },
  apiHandler: async (request) => ({ op: request.op, servedBy: 'carol' }),
})
const dave = makeNode({
  machineId: 'dave',
  machineName: 'Dave laptop',
  relay: { url: relay.url, secret: RELAY_SECRET },
  apiHandler: async (request, peerId) => ({ op: request.op, payload: request.payload, servedBy: 'dave', from: peerId }),
})
await carol.start()
await dave.start()
await carol.setPeers([{ id: 'dave', name: 'Dave laptop', transport: 'relay', enabled: true }])
await dave.setPeers([{ id: 'carol', name: 'Carol desktop', transport: 'relay', enabled: true }])

await check('two nodes meet through the relay', async () => {
  await waitOnline(carol, 'dave', 10000)
  assert.equal(relay.nodes(), 2)
})

await check('the relay carries a working tunnel', async () => {
  const answer = await carol.call('dave', 'ping', { hello: 'relayed' })
  assert.equal(answer.op, 'ping')
  assert.equal(answer.servedBy, 'dave')
})

await check('the relay only ever sees ciphertext', async () => {
  const canary = 'PLAINTEXT-CANARY-dsh-remote-mesh'
  const answer = await carol.call('dave', 'echo', { canary })
  assert.equal(answer.op, 'echo')
  assert.ok(relayedPayloads.length > 0, 'the relay forwarded no payloads at all')
  const seen = Buffer.concat(relayedPayloads)
  assert.equal(seen.includes(canary), false, 'the relay observed plaintext on the wire')
})

await check('a node with a bad relay token is refused', async () => {
  const eavesdropper = makeNode({
    machineId: 'eavesdropper',
    machineName: 'Eavesdropper',
    relay: { url: relay.url, secret: 'not-the-relay-secret-0123456789' },
  })
  await eavesdropper.start()
  await delay(600)
  assert.equal(eavesdropper.relay.status, 'offline')
  await eavesdropper.stop()
})

await alice.stop()
await bob.stop()
await carol.stop()
await dave.stop()
await relay.close()
await target.close()

process.stdout.write(`\n${passed} checks passed\n`)
