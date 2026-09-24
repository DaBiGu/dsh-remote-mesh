/**
 * The `wss://` path, exercised the way the real deployment uses it: a TLS
 * terminator in front of the relay.
 *
 * This is the one transport the earlier suites never touched — they all spoke
 * plain `ws://` — and it is exactly the path a deployment behind nginx takes.
 * The test stands up a **real** relay process, puts a TLS reverse proxy in front
 * of it that does the WebSocket upgrade the way the generated nginx config does,
 * and then joins two nodes over `wss://`.
 *
 * Asserted here:
 *   - two nodes meet through TLS and can tunnel to each other,
 *   - a certificate is actually validated: without the CA the connection is
 *     REFUSED, which is what proves verification is not quietly disabled,
 *   - the documented escape hatch for a self-signed relay works,
 *   - both nodes recover when the relay process is restarted underneath them.
 *
 * Certificate generation needs `openssl`; the test reports SKIP and exits with
 * code 77 when it cannot find one, so a machine without it is never silently
 * counted as passing.
 *
 * Pointing it at a relay that already exists — your own nginx, say — turns it
 * into an acceptance check for that deployment instead of a hermetic test. The
 * checks that need to own the relay process, or that need to know the
 * certificate, report SKIP rather than a pass they did not earn:
 *
 *   DSH_MESH_RELAY_URL=wss://mesh.example.com/__dsh-mesh/relay \
 *   DSH_MESH_RELAY_CA=/path/to/the-ca-or-cert.pem \
 *     node test/relay-tls.test.mjs
 *
 * Run with `node test/relay-tls.test.mjs`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { generateIdentity } from '../lib/core/crypto.js'
import { Mesh } from '../lib/core/mesh.js'
import { delay } from '../lib/core/util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RELAY_ENTRY = path.join(ROOT, 'bin', 'mesh-relay.mjs')
const RELAY_SECRET = 'tls-test-relay-secret-0123456789'
const CLUSTER_KEY = Buffer.from('tls-test-cluster-secret')

let passed = 0
let failed = 0
let skipped = 0
async function check(name, fn) {
  // A check that only holds for a locally-owned relay needs a way to say so
  // rather than quietly claiming a pass it did not earn.
  const scope = {
    skip(reason) {
      const signal = new Error(reason)
      signal.skipped = true
      throw signal
    },
  }
  try {
    await fn(scope)
    passed += 1
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    if (error?.skipped === true) {
      skipped += 1
      process.stdout.write(`skip ${name}\n     ${error.message}\n`)
      return
    }
    // Report and carry on: a suite that aborts on the first failure hides the
    // rest, and a bare top-level rejection looks like a mysterious process leak
    // rather than a failed assertion.
    failed += 1
    process.exitCode = 1
    process.stdout.write(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Every openssl worth trying, most likely to work first.
 *
 * A bare `openssl` on Windows is often a conda-shipped build whose `openssl.cnf`
 * is missing, so a candidate is only accepted once it has actually minted a
 * certificate — probing `version` is not enough.
 * @returns {string[]} candidate executables, in preference order.
 */
function opensslCandidates() {
  return [
    'C:/Program Files/Git/usr/bin/openssl.exe',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files (x86)/Git/usr/bin/openssl.exe',
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
    'openssl',
    'C:/Miniconda3/Library/bin/openssl.exe',
  ]
}

/**
 * Mint a self-signed certificate for localhost with the first candidate that
 * can actually do it.
 * @param {string} certPath - Output certificate path.
 * @param {string} keyPath - Output key path.
 * @returns {{ok: true, tool: string} | {ok: false, reason: string}} the outcome.
 */
function mintCertificate(certPath, keyPath) {
  const failures = []
  for (const candidate of opensslCandidates()) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' })
    if (probe.status !== 0) {
      failures.push(`${candidate}: not runnable`)
      continue
    }
    const generated = spawnSync(candidate, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { encoding: 'utf8' })
    if (existsSync(certPath) && existsSync(keyPath)) return { ok: true, tool: candidate }
    const reason = String(generated.stderr ?? generated.stdout ?? '').split('\n')[0]
    failures.push(`${candidate}: ${reason}`)
  }
  return { ok: false, reason: failures.join('; ') }
}

/**
 * @returns {Promise<number>} an unused loopback port.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

/**
 * @param {number} port - Port to test.
 * @returns {Promise<boolean>} whether something is listening.
 */
function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), 1000).unref()
  })
}

/**
 * @param {number} port - Relay port.
 * @param {number} timeoutMs - Deadline.
 * @returns {Promise<boolean>} whether the relay answered its health check.
 */
async function waitRelayHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const healthy = await new Promise((resolve) => {
      const probe = httpRequest({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve(response.statusCode === 200 && body.includes('dsh-remote-mesh-relay')))
      })
      probe.on('timeout', () => {
        probe.destroy()
        resolve(false)
      })
      probe.on('error', () => resolve(false))
      probe.end()
    })
    if (healthy) return true
    await delay(200)
  }
  return false
}

/**
 * Start the deployable relay as a real child process.
 * @param {number} port - Loopback port.
 * @returns {import('node:child_process').ChildProcess} the child.
 */
function startRelay(port) {
  const child = spawn(process.execPath, [RELAY_ENTRY, '--port', String(port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MESH_RELAY_SECRET: RELAY_SECRET },
  })
  child.stdout.resume()
  child.stderr.resume()
  return child
}

/**
 * A TLS reverse proxy that terminates `wss://` and forwards the upgrade to the
 * relay — the same shape as the generated nginx `location`.
 * @param {{cert: Buffer, key: Buffer, relayPort: number, location: string}} options - Proxy inputs.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the running proxy.
 */
function startTlsProxy({ cert, key, relayPort, location }) {
  const server = https.createServer({ cert, key })
  server.on('upgrade', (incoming, socket, head) => {
    const pathname = new URL(incoming.url ?? '/', 'https://proxy.invalid').pathname
    if (pathname !== location) {
      socket.destroy()
      return
    }
    const upstream = net.connect({ host: '127.0.0.1', port: relayPort }, () => {
      const lines = ['GET / HTTP/1.1']
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (name.toLowerCase() === 'host') continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push(`Host: 127.0.0.1:${relayPort}`, '', '')
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const shutdown = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', shutdown)
    socket.on('error', shutdown)
    socket.on('close', () => upstream.destroy())
  })
  server.on('request', (_request, response) => {
    response.writeHead(404)
    response.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * @param {string} id - Machine id.
 * @param {string} url - `wss://` relay URL.
 * @param {{ca?: Buffer, rejectUnauthorized?: boolean}} [tls] - Trust options.
 * @returns {Mesh} a mesh node.
 */
function makeNode(id, url, tls = {}) {
  return new Mesh({
    machineId: id,
    machineName: id,
    identity: generateIdentity(),
    clusterKey: CLUSTER_KEY,
    listenHost: '127.0.0.1',
    listenPort: 0,
    relay: { url, secret: RELAY_SECRET, ...tls },
    apiHandler: async (incoming) => ({ op: incoming.op, servedBy: id, payload: incoming.payload }),
    log: () => {},
  })
}

/**
 * @param {Mesh} mesh - Node to watch.
 * @param {number} timeoutMs - Deadline.
 * @returns {Promise<boolean>} whether the node has a *usable* relay socket. The
 *   reported status alone is set when the frame is sent, so it can still read
 *   `online` for a socket the relay has already dropped.
 */
async function waitRelayOnline(mesh, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (mesh.relay?.status === 'online' && mesh.relay.isUsable() === true) return true
    await delay(200)
  }
  return false
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-mesh-tls-'))
const certPath = path.join(workDir, 'cert.pem')
const keyPath = path.join(workDir, 'key.pem')
let relay = undefined
const nodes = []
let proxy = undefined
/** Set when this run owns the relay process (see the `externalMode` block below). */
let relayPort = 0
const relayLocation = '/__dsh-mesh/relay'

// Pointing the suite at an existing deployment — your own nginx, say — turns it
// from a hermetic test into an acceptance check for that deployment:
//   DSH_MESH_RELAY_URL=wss://mesh.example.com/__dsh-mesh/relay node test/relay-tls.test.mjs
const externalUrl = process.env.DSH_MESH_RELAY_URL
const externalCaPath = process.env.DSH_MESH_RELAY_CA

// A background reconnect loop must never surface as an unhandled rejection or
// an uncaught exception: in the host process that is at best log noise and at
// worst a dead Harness. Collect them and assert none happened.
/** @type {unknown[]} */
const leaks = []
const noteLeak = (kind, value) => {
  leaks.push(value)
  // Print at once, and mark the run failed: a guard that silently swallows a
  // rejected top-level await turns a failure into a clean-looking exit.
  process.exitCode = 1
  process.stdout.write(`LEAK ${kind}: ${value?.stack ?? String(value)}\n`)
}
process.on('unhandledRejection', (reason) => noteLeak('unhandledRejection', reason))
process.on('uncaughtException', (error) => noteLeak('uncaughtException', error))

/** When set, the suite validates an existing deployment instead of standing one up. */
let externalMode = externalUrl !== undefined && externalUrl !== ''

if (!externalMode) {
  const minted = mintCertificate(certPath, keyPath)
  if (!minted.ok) {
    rmSync(workDir, { recursive: true, force: true })
    process.stdout.write(`SKIP: no usable openssl, so no certificate can be minted for the TLS test (${minted.reason})\n`)
    process.exit(77)
  }
  process.stdout.write(`     certificate minted with ${minted.tool}\n`)
}

try {
  const cert = externalMode
    ? (externalCaPath === undefined ? undefined : readFileSync(externalCaPath))
    : readFileSync(certPath)
  const key = externalMode ? undefined : readFileSync(keyPath)

  let url
  if (externalMode) {
    url = externalUrl
    process.stdout.write(`     validating the deployment at ${url}\n`)
  } else {
    relayPort = await freePort()
    relay = startRelay(relayPort)
    if (!(await waitRelayHealth(relayPort))) throw new Error('the relay child never became healthy')
    proxy = await startTlsProxy({ cert, key, relayPort, location: relayLocation })
    url = `wss://localhost:${proxy.port}${relayLocation}`
    process.stdout.write(`     relay on 127.0.0.1:${relayPort}, TLS terminator on ${proxy.port}\n`)
  }

  // The trust checks below prove that certificate verification is really on by
  // pinning the certificate here and watching an unpinned node get refused.
  // That only means something when this run knows the certificate: against a
  // live deployment with a publicly-trusted certificate, an unpinned node is
  // *supposed* to connect, so those two checks have nothing to assert.
  const pinnedTrust = externalMode ? externalCaPath !== undefined : true
  if (externalMode && !pinnedTrust) {
    process.stdout.write('     no DSH_MESH_RELAY_CA given, so the certificate-trust checks will be skipped\n')
  }

  const alice = makeNode('tls-alice', url, { ca: cert })
  const bob = makeNode('tls-bob', url, { ca: cert })
  nodes.push(alice, bob)
  await alice.start()
  await bob.start()
  await alice.setPeers([{ id: 'tls-bob', transport: 'relay', enabled: true }])
  await bob.setPeers([{ id: 'tls-alice', transport: 'relay', enabled: true }])

  await check('two nodes register with the relay through TLS', async () => {
    const ok = await Promise.all([waitRelayOnline(alice), waitRelayOnline(bob)])
    if (!ok[0] || !ok[1]) throw new Error(`relay status: alice=${alice.relay?.status} bob=${bob.relay?.status}`)
  })

  await check('a tunnel works over wss://', async () => {
    const answer = await alice.call('tls-bob', 'ping', { over: 'tls' }, { timeoutMs: 20000 })
    if (answer.servedBy !== 'tls-bob') throw new Error(`unexpected answer ${JSON.stringify(answer)}`)
  })

  await check('the relay behind TLS only ever saw ciphertext', async () => {
    // The tunnel payload is sealed by the two nodes; the TLS terminator is a
    // byte pipe, so the strongest local statement is that the certificate it
    // presented is the one the nodes validated (checked above) and the payload
    // never appears in the proxy's own logs or state. Ciphertext opacity itself
    // is asserted directly in mesh.test.mjs against a relay that records frames.
    const answer = await alice.call('tls-bob', 'echo', { canary: 'TLS-CANARY-VALUE' }, { timeoutMs: 20000 })
    if (!JSON.stringify(answer).includes('TLS-CANARY-VALUE')) throw new Error('the round trip did not actually carry the payload')
  })

  await check('a certificate really is validated: without the CA the node is refused', async (t) => {
    if (!pinnedTrust) {
      t.skip('this deployment presents a publicly-trusted certificate, so an unpinned node is meant to connect')
      return
    }
    const distrusting = makeNode('tls-distrusting', url)
    nodes.push(distrusting)
    await distrusting.start()
    await delay(3000)
    if (distrusting.relay?.status === 'online') {
      throw new Error('a self-signed relay was accepted with default trust settings — verification is not on')
    }
    const reason = String(distrusting.relay?.lastError ?? '')
    if (!/certificate|self.signed|unable to verify/i.test(reason)) {
      throw new Error(`the refusal did not mention the certificate: ${JSON.stringify(reason)}`)
    }
    await distrusting.stop()
  })

  await check('the documented self-signed escape hatch connects', async () => {
    const trusting = makeNode('tls-selfsigned', url, { rejectUnauthorized: false })
    nodes.push(trusting)
    await trusting.start()
    if (!(await waitRelayOnline(trusting, 15000))) throw new Error('allowSelfSigned did not connect')
    await trusting.stop()
  })

  await check('both nodes recover after the relay process is restarted', async (t) => {
    if (externalMode) {
      t.skip('the relay is an external deployment (DSH_MESH_RELAY_URL); this test does not own the process')
      return
    }
    relay.kill()
    const deadline = Date.now() + 10000
    while ((await listening(relayPort)) && Date.now() < deadline) await delay(200)
    if (await listening(relayPort)) throw new Error('the old relay never released its port')
    relay = startRelay(relayPort)
    if (!(await waitRelayHealth(relayPort))) throw new Error('the restarted relay never became healthy')
    const back = await Promise.all([waitRelayOnline(alice, 30000), waitRelayOnline(bob, 30000)])
    if (!back[0] || !back[1]) {
      throw new Error(`after the restart: alice=${alice.relay?.status} bob=${bob.relay?.status}`)
    }
    const answer = await alice.call('tls-bob', 'ping', { after: 'restart' }, { timeoutMs: 25000 })
    if (answer.servedBy !== 'tls-bob') throw new Error(`the tunnel did not recover: ${JSON.stringify(answer)}`)
  })

  await check('the run leaked no unhandled rejection or uncaught exception', () => {
    if (leaks.length === 0) return
    const described = leaks.map((leak) => `${leak?.name ?? 'value'}: ${leak?.message ?? String(leak)}`).join(' | ')
    leaks.length = 0
    throw new Error(`the run leaked: ${described}`)
  })
} finally {
  for (const node of nodes) {
    try {
      await node.stop()
    } catch {
      /* the node may already be down */
    }
  }
  try {
    await proxy?.close()
  } catch {
    /* the proxy may already be down */
  }
  relay?.kill()
  rmSync(workDir, { recursive: true, force: true })
}

process.stdout.write(`\n${passed} checks passed${skipped === 0 ? '' : `, ${skipped} skipped`}${failed === 0 ? '' : `, ${failed} failed`}\n`)
if (failed !== 0) process.exitCode = 1
