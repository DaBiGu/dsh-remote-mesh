#!/usr/bin/env node
/**
 * Two-node end-to-end check against *real* running Harness instances.
 *
 * This is the closest reproduction of the actual setup: two independent
 * harnesses, each with its own home, paired the way the manual tells you to
 * pair them, then exercised through the paths the panel uses.
 *
 * It needs both instances running, and their per-process boot tokens (read them
 * from a browser console as `__DSH_REMOTE_WORKSPACES__.token`, or from
 * `tools/activate.ps1 -Verify` output — the token is what the fallback carrier
 * requires).
 *
 *   node tools/e2e-two-node.mjs --a-port 3098 --a-token <t> --b-port 3097 --b-token <t>
 *
 * Steps, in order:
 *   1. A generates a pairing code.
 *   2. B accepts it — and must also announce itself back, so ONE paste joins
 *      both ends. This is the step that used to leave a half-connected mesh.
 *   3. Both sides must list the other as an online peer with its inventory.
 *   4. A opens B's GUI through the mesh and fetches it over HTTP.
 *   5. A sends B's agent a prompt and B must answer in its own session log.
 * @module dsh-remote-workspaces/tools/e2e-two-node
 */
import net from 'node:net'
import process from 'node:process'

/**
 * @param {string[]} argv - Process arguments.
 * @returns {Record<string, string>} parsed `--flag value` pairs.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    const key = argv[index].slice(2)
    out[key] = argv[index + 1]
    index += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
for (const required of ['a-port', 'a-token', 'b-port', 'b-token']) {
  if (args[required] === undefined) {
    process.stderr.write(`e2e-two-node: --${required} is required\n`)
    process.exit(2)
  }
}

const A = { port: Number(args['a-port']), token: args['a-token'], label: 'A' }
const B = { port: Number(args['b-port']), token: args['b-token'], label: 'B' }

let failures = 0
/**
 * @param {string} name - What is being asserted.
 * @param {() => void} assertion - Throws on failure.
 */
function check(name, assertion) {
  try {
    assertion()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Call one plugin method on one instance.
 * @param {{port: number, token: string, label: string}} node - Target instance.
 * @param {string} method - Method name.
 * @param {Record<string, unknown>} [payload] - Method payload.
 * @returns {Promise<any>} the unwrapped value.
 */
async function call(node, method, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${node.port}/remote-workspaces/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-remote-workspaces-token': node.token },
    body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}`, method, payload }),
  })
  const envelope = await response.json()
  const result = envelope.result
  if (result === null || typeof result !== 'object' || result.ok !== true) {
    const error = (result && result.error) || {}
    throw new Error(`${node.label}.${method} failed: HTTP ${response.status} ${error.code ?? ''} ${error.message ?? ''}`)
  }
  return result.value
}

/**
 * @param {{port: number, token: string, label: string}} node - Instance to poll.
 * @param {string} peerId - Peer to wait for.
 * @param {number} timeoutMs - Deadline.
 * @returns {Promise<Record<string, unknown>>} the peer record once online.
 */
async function waitOnline(node, peerId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const state = await call(node, 'state')
    last = (state.peers || []).find((peer) => peer.id === peerId)
    if (last && last.status === 'online') return last
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`${node.label} never saw ${peerId} online: ${JSON.stringify(last)}`)
}

/**
 * A peer goes `online` when the link is up, but its workspace and conversation
 * inventory only appears once the first snapshot exchange finishes, so waiting
 * on the link alone would race.
 * @param {{port: number, token: string, label: string}} node - Instance to poll.
 * @param {string} peerId - Peer whose inventory to wait for.
 * @param {number} timeoutMs - Deadline.
 * @returns {Promise<Record<string, unknown>>} the peer record with its inventory.
 */
async function waitInventory(node, peerId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const state = await call(node, 'state')
    last = (state.peers || []).find((peer) => peer.id === peerId)
    if (last && last.snapshotAt) {
      if (last.snapshotError) throw new Error(`${node.label} could not read ${peerId}'s inventory: ${last.snapshotError}`)
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${node.label} never received ${peerId}'s inventory: ${JSON.stringify(last)}`)
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
    setTimeout(() => done(false), 2000).unref()
  })
}

process.stdout.write('=== two-node end-to-end check\n')

const beforeA = await call(A, 'state')
const beforeB = await call(B, 'state')
process.stdout.write(`     A is ${beforeA.self.id} (${beforeA.self.name})\n`)
process.stdout.write(`     B is ${beforeB.self.id} (${beforeB.self.name})\n`)
check('the two instances have distinct identities', () => {
  if (beforeA.self.id === beforeB.self.id) throw new Error('both instances report the same machine id')
})

// ---------------------------------------------------------------- 1. pair.create
const created = await call(A, 'pair.create')
check('A generates a pairing code', () => {
  if (typeof created.code !== 'string' || created.code.length < 40) throw new Error('the code is suspiciously short')
  const blob = JSON.parse(Buffer.from(created.code, 'base64url').toString('utf8'))
  if (typeof blob.clusterKey !== 'string') throw new Error('the code carries no cluster key')
  if (blob.from.id !== beforeA.self.id) throw new Error('the code names the wrong machine')
})

// ---------------------------------------------------------------- 2. pair.accept
const accepted = await call(B, 'pair.accept', { code: created.code })
check('B accepts the code and announces itself back, so ONE paste joins both ends', () => {
  if (accepted.announced !== true) {
    throw new Error(`B could not announce itself back: ${accepted.announceError ?? 'no reason given'}`)
  }
  const peers = (accepted.peers || []).map((peer) => peer.id)
  if (!peers.includes(beforeA.self.id)) throw new Error(`B did not end up with A as a peer (${peers.join(', ')})`)
})

// ---------------------------------------------------------------- 3. both directions
const peerAtA = await waitOnline(A, beforeB.self.id)
const peerAtB = await waitOnline(B, beforeA.self.id)
const inventoryAtA = await waitInventory(A, beforeB.self.id)
await waitInventory(B, beforeA.self.id)
check('A lists B as an online peer with its inventory', () => {
  if (peerAtA.status !== 'online') throw new Error(`A sees B as ${peerAtA.status}`)
})
check('B lists A as an online peer with its inventory', () => {
  if (peerAtB.status !== 'online') throw new Error(`B sees A as ${peerAtB.status}`)
})
check('the mirrored inventory carries at least one workspace and one conversation', () => {
  const workspaces = inventoryAtA.workspaces || []
  const sessions = inventoryAtA.sessions || []
  if (workspaces.length === 0) throw new Error('A sees no workspaces on B')
  if (sessions.length === 0) throw new Error('A sees no conversations on B')
  process.stdout.write(`     A sees ${workspaces.length} workspace(s) and ${sessions.length} conversation(s) on B\n`)
})

// ---------------------------------------------------------------- 4. remote GUI proxy
const opened = await call(A, 'open.peer', { peerId: beforeB.self.id })
check('A maps B\'s GUI onto a loopback port', async () => {
  if (typeof opened.port !== 'number' || opened.port <= 0) throw new Error(`no port: ${JSON.stringify(opened)}`)
})
const proxyUrl = opened.tokenUrl || opened.url
const guiResponse = await fetch(proxyUrl, { redirect: 'manual' })
check('the proxied GUI answers with the real Harness shell', async () => {
  if (guiResponse.status !== 200 && guiResponse.status !== 303) throw new Error(`HTTP ${guiResponse.status}`)
  const body = guiResponse.status === 200 ? await guiResponse.text() : ''
  if (guiResponse.status === 200 && !body.includes('__DSH_BOOT__')) throw new Error('the response is not the Harness shell')
})
check('an unauthenticated request through the same tunnel is refused', async () => {
  const bare = await fetch(`http://127.0.0.1:${opened.port}/`, { redirect: 'manual' })
  if (bare.status !== 401 && bare.status !== 303) {
    throw new Error(`expected the remote Harness to demand auth, got HTTP ${bare.status}`)
  }
})

// ---------------------------------------------------------------- 5. remote agent
const marker = `E2E-${Date.now().toString(36)}`
const prompted = await call(A, 'agent.prompt', {
  peerId: beforeB.self.id,
  text: `只回复这一串字符，不要加任何其它内容，也不要调用任何工具：${marker}`,
})
check('A hands a prompt to B\'s agent and B accepts it', () => {
  if (prompted.accepted !== true) throw new Error(`not accepted: ${JSON.stringify(prompted)}`)
  if (typeof prompted.sessionId !== 'string' || prompted.sessionId === '') throw new Error('no session id came back')
})
process.stdout.write(`     B created session ${prompted.sessionId}; waiting for its agent to answer...\n`)

let answered = false
const deadline = Date.now() + 180000
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const conversation = await call(A, 'conversation', { peerId: beforeB.self.id, sessionId: prompted.sessionId, limit: 10 })
  const hit = (conversation.messages || []).find((message) => message.role === 'assistant' && message.text.includes(marker))
  if (hit) {
    answered = true
    break
  }
}
check('B\'s agent really ran, and A can read the reply over the mesh', () => {
  if (!answered) throw new Error(`no assistant message containing ${marker} within the deadline`)
})

process.stdout.write(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
