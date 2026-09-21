#!/usr/bin/env node
/**
 * Standalone mesh peer, for verifying the remote-workspaces plugin without a second
 * Harness install.
 *
 * It is the *other machine* in the test: it joins the same cluster, serves a
 * `#api` snapshot, tunnels inbound streams to a loopback port, and can either
 * probe or drive the real Harness node it is paired with.
 *
 * Modes:
 *   node tools/mesh-peer.mjs serve   --config <file>
 *   node tools/mesh-peer.mjs probe   --config <file> --peer <id>
 *   node tools/mesh-peer.mjs prompt  --config <file> --peer <id> --text '<...>'
 *
 * The config file is JSON:
 *   { id, name, clusterKey, listenHost, listenPort, peers: [...],
 *     webPort, launchToken, mirrorSnapshotFrom?, proxyConversationTo?,
 *     proxyPromptTo?, snapshot: { workspaces: [...], sessions: [...] } }
 *
 * `launchToken` is answered only to an explicit `launch-token` request, matching
 * the real host, which keeps it out of the periodically exchanged snapshot.
 * @module dsh-remote-workspaces/tools/mesh-peer
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { generateIdentity } from '../lib/core/crypto.js'
import { Mesh } from '../lib/core/mesh.js'

const [, , mode = 'serve', ...rest] = process.argv

/**
 * @param {string[]} argv - Arguments after the mode.
 * @returns {Record<string, string>} parsed `--flag value` pairs.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    const key = argv[index].slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = 'true'
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(rest)
const configPath = args.config
if (configPath === undefined) {
  process.stderr.write('mesh-peer: --config <file> is required\n')
  process.exit(2)
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))

const log = (message) => process.stdout.write(`${new Date().toISOString()} peer ${config.id}: ${message}\n`)

const mesh = new Mesh({
  machineId: config.id,
  machineName: config.name,
  identity: generateIdentity(),
  clusterKey: Buffer.from(config.clusterKey, 'base64url'),
  listenHost: config.listenHost ?? '127.0.0.1',
  listenPort: config.listenPort ?? 0,
  relay: config.relay,
  log,
  apiHandler: async (request) => {
    if (request.op === 'ping') return { pong: true, machine: config.id }
    // A mirror node answers the requests it cannot serve itself from the real
    // node it mirrors, so one Harness install can exercise every client path.
    const mirror = config.mirrorSnapshotFrom
    if (request.op === 'conversation') {
      const target = config.proxyConversationTo ?? mirror
      if (target === undefined) throw new Error('mesh-peer does not implement conversation')
      return await mesh.call(target, 'conversation', request.payload, { timeoutMs: 30000 })
    }
    if (request.op === 'agent.prompt' || request.op === 'agent.create') {
      const target = config.proxyPromptTo ?? mirror
      if (target === undefined) throw new Error(`mesh-peer does not implement ${request.op}`)
      return await mesh.call(target, request.op, request.payload, { timeoutMs: 60000 })
    }
    if (request.op === 'launch-token') {
      // Mirrors the real host: handed out on request, never in the snapshot.
      if (config.launchToken === undefined) throw new Error('mesh-peer has no launchToken configured')
      return { token: config.launchToken }
    }
    if (request.op !== 'snapshot') throw new Error(`mesh-peer does not implement ${request.op}`)
    if (mirror !== undefined) {
      const mirrored = await mesh.call(mirror, 'snapshot', {}, { timeoutMs: 20000 })
      return { ...mirrored, machine: { id: config.id, name: config.name, hostname: config.hostname ?? config.id, platform: process.platform } }
    }
    return {
      machine: { id: config.id, name: config.name, hostname: config.hostname ?? config.id, platform: process.platform },
      webPort: config.webPort ?? 0,
      workspaces: config.snapshot?.workspaces ?? [],
      sessions: config.snapshot?.sessions ?? [],
      sessionCount: (config.snapshot?.sessions ?? []).length,
      runningCount: (config.snapshot?.sessions ?? []).filter((session) => session.running === true).length,
      forwards: [],
      time: Date.now(),
    }
  },
})

if (mode === 'serve') {
  await mesh.start()
  await mesh.setPeers(config.peers ?? [])
  log(`listening on ${config.listenHost ?? '127.0.0.1'}:${mesh.boundPort}`)
  // Report peer reachability, so the test can assert the link came up.
  setInterval(() => {
    for (const peer of mesh.snapshotPeers()) log(`peer ${peer.id} status=${peer.status}${peer.error === undefined ? '' : ` error=${peer.error}`}`)
  }, 5000).unref()
  process.on('SIGINT', async () => {
    await mesh.stop()
    process.exit(0)
  })
} else if (mode === 'probe') {
  const peerId = args.peer
  if (peerId === undefined) {
    process.stderr.write('mesh-peer probe: --peer <id> is required\n')
    process.exit(2)
  }
  await mesh.start()
  await mesh.setPeers(config.peers ?? [])
  const snapshot = await mesh.call(peerId, 'snapshot', {}, { timeoutMs: 30000 })
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
  await mesh.stop()
  process.exit(0)
} else if (mode === 'prompt') {
  const peerId = args.peer
  const text = args.text
  if (peerId === undefined || text === undefined) {
    process.stderr.write('mesh-peer prompt: --peer <id> and --text <text> are required\n')
    process.exit(2)
  }
  await mesh.start()
  await mesh.setPeers(config.peers ?? [])
  const answer = await mesh.call(
    peerId,
    'agent.prompt',
    {
      text,
      mode: 'queue',
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.workspace === undefined ? {} : { workspaceId: args.workspace }),
    },
    { timeoutMs: 90000 },
  )
  process.stdout.write(`prompt accepted: ${JSON.stringify(answer)}\n`)
  await mesh.stop()
  process.exit(0)
} else if (mode === 'conversation') {
  const peerId = args.peer
  const sessionId = args.session
  if (peerId === undefined || sessionId === undefined) {
    process.stderr.write('mesh-peer conversation: --peer <id> and --session <id> are required\n')
    process.exit(2)
  }
  await mesh.start()
  await mesh.setPeers(config.peers ?? [])
  const answer = await mesh.call(
    peerId,
    'conversation',
    { sessionId, limit: args.limit === undefined ? 20 : Number(args.limit) },
    { timeoutMs: 60000 },
  )
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`)
  await mesh.stop()
  process.exit(0)
} else {
  process.stderr.write(`mesh-peer: unknown mode ${JSON.stringify(mode)}\n`)
  process.exit(2)
}
