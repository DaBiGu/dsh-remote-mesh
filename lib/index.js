/**
 * remote-workspaces — host half.
 *
 * Gives the DSH Web GUI a *remote-workspaces* surface: the workspaces and
 * conversations of your other machines, their whole GUI proxied onto a local
 * loopback port, and loopback port forwards for debugging a page that is
 * running somewhere else.
 *
 * Everything crosses one end-to-end encrypted mesh. The public relay that joins
 * two NATs only ever forwards ciphertext; tunnel targets, DSH launch tokens and
 * conversation content are sealed with a cluster key that never leaves the
 * user's machines.
 *
 * This file owns:
 *   - the persisted node configuration (identity, cluster key, relay, peers)
 *   - the mesh instance and its inbound policy
 *   - the authenticated `/remote-workspaces` RPC channel the browser half calls
 *   - the per-peer GUI proxy and the port forwards, both plain TCP plumbing
 *     onto mesh streams
 *   - the `#api` snapshot other machines read to list this machine's work
 * @module dsh-remote-workspaces
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { generateIdentity } from './core/crypto.js'
import { Mesh } from './core/mesh.js'
import { MeshError, asPort, delay, isRecord } from './core/util.js'

/** Directory this plugin keeps its own state in, under the Harness home. */
const STATE_DIR_NAME = 'dsh-remote-workspaces'
/** Browser-facing RPC channel, shared by both carriers. */
const CHANNEL = '/remote-workspaces'
/** Request header carrying the per-process boot token on the fallback carrier. */
const TOKEN_HEADER = 'x-dsh-remote-workspaces-token'
/** Global the page reads the boot token from. */
const GLOBAL_NAME = '__DSH_REMOTE_WORKSPACES__'
/** First port tried for a peer's GUI proxy; the next peers walk upward. */
const PROXY_PORT_BASE = 34100
/** Bytes of log ring buffer kept for the diagnostics view. */
const LOG_LIMIT = 200
/** Sessions listed per workspace snapshot, newest first. */
const SESSIONS_PER_SNAPSHOT = 120

/** Cordis requires these before the plugin body runs. */
export const inject = ['webServer', 'connection']
/** Plugin identity, for logs and the plugin inventory. */
export const name = 'remote-workspaces'

/**
 * @returns {string} the resolved Harness home, matching the documented precedence.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * @returns {string} a filesystem-safe slug for this machine's hostname.
 */
function hostSlug() {
  const slug = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'machine' : slug.slice(0, 24)
}

/**
 * Read the persisted configuration, creating it on first run.
 * @param {string} file - Configuration path.
 * @param {Record<string, any>} overrides - Plugin-level overrides.
 * @returns {{config: Record<string, any>, created: boolean}} the configuration and whether it was just created.
 */
function loadConfig(file, overrides) {
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== 1) throw new MeshError('config/version', `${file} is not a version-1 remote-workspaces configuration`)
    return { config: { ...parsed, ...overrides }, created: false }
  }
  const identity = generateIdentity()
  const config = {
    version: 1,
    machine: { id: `${hostSlug()}-${randomBytes(2).toString('hex')}`, name: os.hostname() },
    identity: {
      privateKey: identity.privateKey.toString('base64url'),
      publicKey: identity.publicKey.toString('base64url'),
    },
    clusterKey: randomBytes(32).toString('base64url'),
    relay: { url: '', secret: randomBytes(32).toString('base64url'), ca: '', allowSelfSigned: false },
    listenHost: '127.0.0.1',
    listenPort: 39301,
    pollMs: 20000,
    peers: [],
    forwards: [],
    ...overrides,
  }
  writeConfig(file, config)
  return { config, created: true }
}

/**
 * Persist configuration through a temporary file so a crash cannot leave a
 * half-written identity on disk.
 * @param {string} file - Configuration path.
 * @param {Record<string, any>} config - Configuration to persist.
 * @returns {void}
 */
function writeConfig(file, config) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

/**
 * Bind a loopback TCP listener, falling back to an OS-assigned port.
 * @param {number} preferred - Port to try first.
 * @param {(socket: net.Socket) => void} onSocket - Connection handler.
 * @returns {Promise<{server: net.Server, port: number}>} the listening server.
 */
function listenLoopback(preferred, onSocket) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      const server = net.createServer({ pauseOnConnect: false }, (socket) => {
        socket.setNoDelay(true)
        onSocket(socket)
      })
      server.once('error', (error) => {
        if (port !== 0 && error.code === 'EADDRINUSE') {
          attempt(0)
          return
        }
        reject(new MeshError('proxy/listen', `cannot listen on 127.0.0.1:${port}: ${error.message}`))
      })
      server.once('listening', () => {
        const address = server.address()
        resolve({ server, port: typeof address === 'object' && address !== null ? address.port : port })
      })
      server.listen({ host: '127.0.0.1', port })
    }
    attempt(preferred)
  })
}

/**
 * Pipe a loopback socket onto a mesh stream in both directions.
 *
 * A failed tunnel answers with an explanatory 502 rather than a bare reset: the
 * most likely reason a mapped page is blank is that the other machine's Harness
 * is not running, and a connection reset tells the operator nothing.
 * @param {net.Socket} socket - Accepted loopback connection.
 * @param {Promise<import('node:stream').Duplex>} pending - Pending mesh stream.
 * @param {string} what - Human description of what was being tunnelled.
 * @returns {void}
 */
function bridge(socket, pending, what) {
  pending.then(
    (stream) => {
      const shutdown = () => {
        socket.destroy()
        stream.destroy()
      }
      socket.on('error', shutdown)
      stream.on('error', shutdown)
      socket.on('close', () => stream.destroy())
      stream.on('close', () => socket.destroy())
      socket.pipe(stream)
      stream.pipe(socket)
    },
    (error) => writeTunnelFailure(socket, what, error),
  )
}

/**
 * Answer one failed tunnel with a page that says what to check.
 * @param {net.Socket} socket - Accepted loopback connection.
 * @param {string} what - Human description of the target.
 * @param {unknown} error - Tunnel failure.
 * @returns {void}
 */
function writeTunnelFailure(socket, what, error) {
  const reason = error instanceof Error ? error.message : String(error)
  const body = [
    '<!doctype html><meta charset="utf-8"><title>remote-workspaces: 远端不可用</title>',
    '<body style="font:14px/1.7 system-ui,-apple-system,Segoe UI,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a">',
    '<h1 style="font-size:1.15rem">remote-workspaces：暂时够不到远端</h1>',
    `<p style="color:#444">${escapeHtml(what)}</p>`,
    `<pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:10px;white-space:pre-wrap">${escapeHtml(reason)}</pre>`,
    '<p>按顺序检查：</p><ol>',
    '<li>对面那台电脑的 <code>dsh web</code> 还在运行吗？（`remote-workspaces` 面板里那台机器显示「已连接」只代表 Mesh 通了，不代表它的 GUI 在跑）</li>',
    '<li>你要转发的端口，在远端真的有服务在监听吗？</li>',
    '<li>远端防火墙是否只允许本地回环访问该端口？（隧道走的是远端的 127.0.0.1，通常不受防火墙影响）</li>',
    '</ol>',
    '<p style="color:#71717a">本页面由 dsh-remote-workspaces 生成。</p></body>',
  ].join('')
  try {
    socket.end(
      'HTTP/1.1 502 Bad Gateway\r\n'
      + 'Content-Type: text/html; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + 'Cache-Control: no-store\r\n'
      + 'Connection: close\r\n\r\n'
      + body,
    )
  } catch {
    socket.destroy()
  }
}

/**
 * @param {unknown} value - Text to place in HTML.
 * @returns {string} the escaped text.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Mount the remote-workspaces host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {Record<string, any>} [pluginConfig] - Inline overrides from the bundle row.
 * @returns {void}
 */
export function apply(ctx, pluginConfig = {}) {
  const stateDir = path.join(harnessHome(), STATE_DIR_NAME)
  const configFile = path.join(stateDir, 'config.json')
  let loaded
  try {
    loaded = loadConfig(configFile, pluginConfig)
  } catch (error) {
    ctx.logger?.error?.(`[remote-workspaces] ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const config = loaded.config
  const logs = []
  const logFile = path.join(stateDir, 'plugin.log')
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`
    logs.push(line)
    if (logs.length > LOG_LIMIT) logs.shift()
    // The Harness logger is level-filtered and may not reach this process's
    // stdout, so a failing plugin must also leave a trace a human can read.
    try {
      appendFileSync(logFile, `${line}\n`)
    } catch {
      /* diagnostics must never break the plugin */
    }
    try {
      ctx.logger?.info?.(`[remote-workspaces] ${message}`)
    } catch {
      /* the logger may not accept this shape */
    }
  }

  /** @type {Map<string, {server: net.Server, port: number}>} */
  const proxies = new Map()
  /** @type {Map<string, {server: net.Server, port: number}>} */
  const forwarders = new Map()
  /** @type {Map<string, {at: number, value?: Record<string, any>, error?: string}>} */
  const snapshots = new Map()
  const runtime = { watchers: 0, lastWatchAt: 0, poller: undefined, started: false }
  /** Peers whose inventory has already been fetched for their current link. */
  const seenOnline = new Set()
  /** Per-process secret the page must present on the fallback carrier. */
  let bootToken = ''

  const identity = {
    privateKey: Buffer.from(config.identity.privateKey, 'base64url'),
    publicKey: Buffer.from(config.identity.publicKey, 'base64url'),
  }
  const clusterKey = Buffer.from(config.clusterKey, 'base64url')

  const mesh = new Mesh({
    machineId: config.machine.id,
    machineName: config.machine.name,
    identity,
    clusterKey,
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    relay: relaySettings(),
    apiHandler: (request, peerId) => handlePeerRequest(request, peerId),
    onInboundTcp: () => true,
    log,
  })
  mesh.on('peers', () => {
    // A peer that just came online has no inventory yet. Fetch it once right
    // away — otherwise the list stays empty until a browser happens to open the
    // panel, which is not what "automatically synced" should mean.
    const online = mesh.snapshotPeers().filter((peer) => peer.status === 'online' && peer.enabled !== false)
    const onlineIds = new Set(online.map((peer) => peer.id))
    for (const id of [...seenOnline]) if (!onlineIds.has(id)) seenOnline.delete(id)
    const fresh = online.filter((peer) => !seenOnline.has(peer.id))
    for (const peer of online) seenOnline.add(peer.id)
    if (fresh.length > 0) void Promise.all(fresh.map((peer) => pollPeer(peer.id, true)))
    schedulePoll(0)
  })

  /**
   * Serve one `#api` request from a peer. A peer is a cluster member: the link
   * authenticated it with the shared cluster secret, so it may read this
   * machine's own workspace listing and the launch token for its GUI.
   * @param {Record<string, unknown>} request - `{op, payload}`.
   * @param {string} peerId - The peer that asked.
   * @returns {Promise<unknown>} the answer.
   */
  async function handlePeerRequest(request, peerId) {
    const op = String(request.op ?? '')
    if (op === 'ping') return { pong: true, machine: config.machine.id, time: Date.now() }
    if (op === 'snapshot') return await localSnapshot(peerId)
    if (op === 'agent.create') return await createRemoteSession(request.payload, peerId)
    if (op === 'agent.prompt') return await promptRemoteSession(request.payload, peerId)
    if (op === 'conversation') return await readConversation(request.payload)
    if (op === 'pair.announce') return await acceptAnnounce(request.payload, peerId)
    if (op === 'launch-token') {
      // Handed out on request only, so the periodic snapshot never carries it.
      return { token: launchToken() }
    }
    throw new MeshError('api/unknown-op', `this machine does not implement ${JSON.stringify(op)}`)
  }

  /**
   * Record a machine that accepted one of this machine's pairing codes.
   *
   * The announcing id comes from the authenticated link rather than the payload,
   * so a member cannot enrol itself as somebody else.
   * @param {unknown} payload - `{name?, listenHost?, listenPort?}`.
   * @param {string} peerId - The authenticated peer that announced itself.
   * @returns {Promise<{peerId: string, added: boolean}>} what changed.
   */
  async function acceptAnnounce(payload, peerId) {
    const input = isRecord(payload) ? payload : {}
    const existing = config.peers.find((peer) => peer.id === peerId)
    if (existing === undefined) {
      config.peers.push({
        id: peerId,
        name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : peerId,
        transport: config.relay.url === '' ? 'direct' : 'relay',
        host: typeof input.listenHost === 'string' ? input.listenHost : '',
        port: asPort(input.listenPort) ?? 0,
        enabled: true,
      })
      log(`${peerId} announced itself after accepting a pairing code; added as a peer`)
    } else {
      if (typeof input.name === 'string' && input.name.trim() !== '') existing.name = input.name.trim()
      if (typeof input.listenHost === 'string' && input.listenHost !== '') existing.host = input.listenHost
      if (asPort(input.listenPort) !== undefined) existing.port = asPort(input.listenPort)
      log(`${peerId} re-announced itself; peer record refreshed`)
    }
    saveConfig()
    await reconcile()
    void pollPeer(peerId, true)
    return { peerId, added: existing === undefined }
  }

  /**
   * Read one of this machine's conversations as a flat message list, so a peer
   * can show the *content* of a remote dialogue instead of only its title.
   * @param {unknown} payload - `{sessionId, limit?}`.
   * @returns {Promise<{sessionId: string, messages: Record<string, unknown>[], total: number, truncated: boolean}>} the messages.
   */
  async function readConversation(payload) {
    const input = isRecord(payload) ? payload : {}
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    if (sessionId === '') throw new MeshError('api/request', 'a conversation read needs a session id')
    const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(Number(input.limit), 300)) : 40

    let events
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      events = snapshot?.events ?? []
    } else {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined || typeof persistence.open !== 'function') {
        throw new MeshError('api/unsupported', 'this machine cannot read session logs')
      }
      const handle = await persistence.open(sessionId, 'read')
      try {
        const result = await handle.read()
        events = result?.events ?? []
      } finally {
        await handle.close?.()
      }
    }

    const messages = []
    for (const event of events) {
      if (event?.type === 'user/message') {
        const text = textOfContent(event.data?.content)
        if (text !== '') messages.push({ role: 'user', text, time: event.time })
      } else if (event?.type === 'assistant/message') {
        const text = textOfContent(event.data?.message?.content)
        if (text !== '') {
          messages.push({
            role: 'assistant',
            text,
            time: event.time,
            model: event.data?.message?.source?.model,
          })
        }
      }
    }
    const bounded = messages.slice(-limit)
    return {
      sessionId,
      messages: bounded,
      total: messages.length,
      truncated: bounded.length < messages.length,
    }
  }

  /**
   * Create (or adopt) a conversation on this machine for a peer to drive.
   * @param {unknown} payload - `{cwd?, workspaceId?}`.
   * @param {string} peerId - The peer that asked.
   * @returns {Promise<{sessionId: string}>} the conversation identity.
   */
  async function createRemoteSession(payload, peerId) {
    const controller = ctx.get('sessionController')
    if (controller === undefined) throw new MeshError('api/unsupported', 'this machine has no session controller')
    const input = isRecord(payload) ? payload : {}
    const request = {}
    if (typeof input.workspaceId === 'string' && input.workspaceId !== '') request.workspaceId = input.workspaceId
    else if (typeof input.cwd === 'string' && input.cwd.trim() !== '') request.cwd = input.cwd.trim()
    const created = await controller.create(request)
    log(`peer ${peerId} created session ${created.sessionId}`)
    return { sessionId: String(created.sessionId) }
  }

  /**
   * Admit one prompt into a conversation on this machine, so the *remote* agent
   * does the work while the local operator watches. This is what turns "open the
   * other computer's conversation" into "make the other computer's agent
   * continue the job".
   * @param {unknown} payload - `{sessionId?, cwd?, text, mode?}`.
   * @param {string} peerId - The peer that asked.
   * @returns {Promise<{sessionId: string, accepted: true}>} the receipt.
   */
  async function promptRemoteSession(payload, peerId) {
    const controller = ctx.get('sessionController')
    if (controller === undefined) throw new MeshError('api/unsupported', 'this machine has no session controller')
    const input = isRecord(payload) ? payload : {}
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text === '') throw new MeshError('api/request', 'a prompt needs non-blank text')
    let sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined
    if (sessionId === undefined) {
      const request = {}
      // The Session API accepts a workspace or a directory, never both:
      // naming the workspace is what files the new conversation under it in the
      // remote GUI instead of leaving it in the ungrouped list.
      if (typeof input.workspaceId === 'string' && input.workspaceId !== '') request.workspaceId = input.workspaceId
      else if (typeof input.cwd === 'string' && input.cwd.trim() !== '') request.cwd = input.cwd.trim()
      const created = await controller.create(request)
      sessionId = String(created.sessionId)
    }
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: input.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      new AbortController().signal,
    )
    log(`peer ${peerId} prompted session ${sessionId}`)
    return { sessionId, accepted: true }
  }

  /**
   * List this machine's conversations with their live facts.
   * @returns {Promise<Map<string, Record<string, any>>>} summaries keyed by id.
   */
  async function listConversations() {
    const controller = ctx.get('sessionController')
    const found = new Map()
    if (controller !== undefined) {
      try {
        const listed = await controller.list({}, new AbortController().signal)
        for (const item of listed?.items ?? []) {
          const id = String(item.sessionId ?? '')
          if (id === '') continue
          found.set(id, {
            id,
            cwd: item.cwd,
            updatedAt: item.updatedAt,
            running: item.running === true,
            blank: item.blank === true,
            origin: item.origin,
          })
        }
        return found
      } catch (error) {
        log(`session controller listing failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const query = ctx.get('sessionQuery')
    const persistence = ctx.get('sessionPersistence')
    if (query !== undefined && typeof query.listSessions === 'function') {
      for (const record of await query.listSessions()) {
        const id = String(record.header?.id ?? '')
        if (id === '') continue
        found.set(id, { id, cwd: record.header?.cwd, updatedAt: record.header?.createdAt, running: record.live === true, blank: false })
      }
      return found
    }
    if (persistence !== undefined && typeof persistence.list === 'function') {
      for (const snapshot of await persistence.list()) {
        const id = String(snapshot.header?.id ?? '')
        if (id === '') continue
        found.set(id, { id, cwd: snapshot.header?.cwd, updatedAt: snapshot.header?.createdAt, running: false, blank: false })
      }
    }
    return found
  }

  /**
   * @returns {string|undefined} this process's browser launch token, if the
   *   connection service exposes one.
   */
  function launchToken() {
    try {
      const url = ctx.connection?.authenticatedUrl?.('http://127.0.0.1/')
      if (typeof url !== 'string') return undefined
      return new URL(url).searchParams.get('token') ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * Build the snapshot other machines read: this machine's workspaces, its
   * recent conversations, and the facts a peer needs to open its GUI.
   * @param {string} [peerId] - Asking peer, for logging only.
   * @returns {Promise<Record<string, unknown>>} the snapshot.
   */
  async function localSnapshot(peerId) {
    const registry = ctx.get('workspaceRegistry')
    const query = ctx.get('sessionQuery')

    const conversations = [...(await listConversations()).values()]
    conversations.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    const recent = conversations.slice(0, SESSIONS_PER_SNAPSHOT)

    const titles = new Map()
    if (query !== undefined && typeof query.readTitleSnapshots === 'function' && recent.length > 0) {
      try {
        const results = await query.readTitleSnapshots(recent.map((record) => record.id))
        for (const result of results) {
          const observation = result?.value ?? result
          const title = observation?.title?.title
          const id = observation?.header?.id ?? observation?.session?.id
          if (typeof title === 'string' && title !== '' && typeof id === 'string') titles.set(id, title)
        }
      } catch (error) {
        log(`title listing failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    /** @type {Record<string, any>[]} */
    let workspaces = []
    if (typeof registry?.list === 'function') {
      try {
        workspaces = registry.list().map((workspace) => ({
          id: String(workspace.id),
          title: String(workspace.title ?? ''),
          path: String(workspace.path ?? ''),
          updatedAt: workspace.updatedAt,
          sessionIds: [...(workspace.sessionIds ?? [])].map(String),
        }))
      } catch (error) {
        log(`workspace listing failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      machine: { id: config.machine.id, name: config.machine.name, hostname: os.hostname(), platform: process.platform },
      webPort: ctx.webServer?.port ?? 0,
      // The launch token is deliberately NOT here. This snapshot is exchanged on
      // every poll and ends up in the local panel's state, and a credential has
      // no business being retained by a machine that is not using it yet. It is
      // fetched on demand by `open.peer`, which is the only thing that needs it.
      workspaces,
      sessions: recent.map((record) => ({
        id: record.id,
        title: titles.get(record.id) ?? '',
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        running: record.running === true,
        blank: record.blank === true,
      })),
      sessionCount: conversations.length,
      runningCount: conversations.filter((record) => record.running === true).length,
      forwards: config.forwards.map((forward) => ({ id: forward.id, label: forward.label, remotePort: forward.remotePort })),
      time: Date.now(),
      askedBy: peerId,
    }
  }

  /**
   * Refresh the cached snapshot of one peer.
   * @param {string} peerId - Peer to poll.
   * @param {boolean} force - Whether to bypass the cache age check.
   * @returns {Promise<void>} resolves once the cache is updated.
   */
  async function pollPeer(peerId, force) {
    const peer = config.peers.find((entry) => entry.id === peerId)
    if (peer === undefined || peer.enabled === false) return
    const cached = snapshots.get(peerId)
    const ttl = Number(config.pollMs ?? 20000)
    if (!force && cached !== undefined && Date.now() - cached.at < ttl) return
    try {
      const value = await mesh.call(peerId, 'snapshot', {}, { timeoutMs: 15000 })
      snapshots.set(peerId, { at: Date.now(), value: isRecord(value) ? value : {} })
    } catch (error) {
      snapshots.set(peerId, { at: Date.now(), error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Refresh every enabled peer that is online, plus any watcher-driven polling. */
  async function pollAll(force) {
    await Promise.all(config.peers.filter((peer) => peer.enabled !== false).map((peer) => pollPeer(peer.id, force)))
  }

  /**
   * Keep the snapshot cache warm while a browser is looking at the panel.
   * @param {number} waitMs - Delay before the first pass.
   * @returns {void}
   */
  function schedulePoll(waitMs) {
    if (!runtime.started) return
    clearTimeout(runtime.poller)
    runtime.poller = setTimeout(async () => {
      const watching = runtime.watchers > 0 && Date.now() - runtime.lastWatchAt < 120000
      if (watching) await pollAll(false)
      schedulePoll(Number(config.pollMs ?? 20000))
    }, waitMs)
    runtime.poller.unref?.()
  }

  /**
   * Ensure a peer's whole DSH GUI is reachable on a stable loopback port.
   * @param {string} peerId - Peer to expose.
   * @returns {Promise<{port: number, url: string, tokenUrl: string|undefined}>} the local address.
   */
  async function ensureProxy(peerId) {
    const existing = proxies.get(peerId)
    if (existing !== undefined) return describeProxy(peerId, existing.port)
    const peer = config.peers.find((entry) => entry.id === peerId)
    if (peer === undefined) throw new MeshError('mesh/unknown-peer', `no peer named ${JSON.stringify(peerId)}`)
    const index = config.peers.findIndex((entry) => entry.id === peerId)
    const preferred = asPort(peer.proxyPort) ?? PROXY_PORT_BASE + Math.max(0, index)
    const { server, port } = await listenLoopback(preferred, (socket) => {
      const snapshot = snapshots.get(peerId)?.value
      const remotePort = asPort(snapshot?.webPort)
      if (remotePort === undefined) {
        // Same reasoning as a failed tunnel: say what is wrong instead of
        // resetting the connection and leaving a blank tab.
        writeTunnelFailure(
          socket,
          `正在把 ${peerId} 的 DSH GUI 映射到本机，但对面还没有报告它的 dsh web 端口。`,
          new MeshError('mesh/target', '对端没有报告 GUI 端口——那台机器上的 `dsh web` 大概率没在运行'),
        )
        return
      }
      bridge(
        socket,
        mesh.stream(peerId, `127.0.0.1:${remotePort}`, { timeoutMs: 15000 }),
        `正在把 ${peerId} 的 DSH GUI（远端 127.0.0.1:${remotePort}）映射到本机。`,
      )
    })
    proxies.set(peerId, { server, port })
    if (peer.proxyPort !== port) {
      peer.proxyPort = port
      saveConfig()
    }
    log(`GUI proxy for ${peerId} listening on http://127.0.0.1:${port}`)
    return describeProxy(peerId, port)
  }

  /**
   * Ask a peer for its process launch token, which is only needed at the moment
   * the operator opens that machine's GUI.
   * @param {string} peerId - Peer to ask.
   * @returns {Promise<string|undefined>} the token, or undefined when the peer did not supply one.
   */
  async function fetchLaunchToken(peerId) {
    try {
      const answer = await mesh.call(peerId, 'launch-token', {}, { timeoutMs: 15000 })
      return isRecord(answer) && typeof answer.token === 'string' && answer.token !== '' ? answer.token : undefined
    } catch (error) {
      log(`could not fetch the launch token from ${peerId}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * @param {string} peerId - Peer whose proxy is described.
   * @param {number} port - Loopback port.
   * @returns {{port: number, url: string, tokenUrl: string|undefined, remotePort: number|undefined}} the address.
   */
  function describeProxy(peerId, port, token) {
    const snapshot = snapshots.get(peerId)?.value
    const remotePort = asPort(snapshot?.webPort)
    const base = `http://127.0.0.1:${port}/`
    return {
      port,
      url: base,
      tokenUrl: typeof token === 'string' && token !== '' ? `${base}?token=${encodeURIComponent(token)}` : undefined,
      remotePort,
    }
  }

  /**
   * Ensure one port forward is listening locally.
   * @param {Record<string, any>} forward - Persisted forward record.
   * @returns {Promise<{port: number, url: string}>} the local address.
   */
  async function ensureForward(forward) {
    const existing = forwarders.get(forward.id)
    if (existing !== undefined) return { port: existing.port, url: `http://127.0.0.1:${existing.port}/` }
    const preferred = asPort(forward.localPort) ?? 0
    const { server, port } = await listenLoopback(preferred, (socket) => {
      bridge(
        socket,
        mesh.stream(forward.peerId, `127.0.0.1:${forward.remotePort}`, { timeoutMs: 15000 }),
        `正在把 ${forward.peerId} 的 ${forward.remotePort} 端口转发到本机 ${port}。`,
      )
    })
    forwarders.set(forward.id, { server, port })
    if (forward.localPort !== port) {
      forward.localPort = port
      saveConfig()
    }
    log(`port forward ${forward.remotePort} on ${forward.peerId} is local port ${port}`)
    return { port, url: `http://127.0.0.1:${port}/` }
  }

  /** Persist the current configuration. */
  function saveConfig() {
    try {
      writeConfig(configFile, config)
    } catch (error) {
      log(`cannot persist configuration: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Build the relay settings the mesh needs, including how to trust the
   * certificate in front of it.
   *
   * A relay on a personal server is normally behind a real certificate, and
   * then nothing here matters: Node's own trust store validates it. These two
   * knobs exist for the honest other case — a self-signed certificate — where
   * the alternative is telling the operator to weaken verification globally.
   * @returns {{url: string, secret: string, ca?: string, rejectUnauthorized?: boolean}|undefined} the relay config.
   */
  function relaySettings() {
    if (config.relay.url === '') return undefined
    const settings = { url: config.relay.url, secret: config.relay.secret }
    const caPath = typeof config.relay.ca === 'string' ? config.relay.ca.trim() : ''
    if (caPath !== '') {
      try {
        settings.ca = readFileSync(caPath, 'utf8')
      } catch (error) {
        log(`cannot read the relay CA at ${caPath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (config.relay.allowSelfSigned === true) {
      settings.rejectUnauthorized = false
      log('relay certificate verification is OFF (allowSelfSigned); this is acceptable only on a link you already trust')
    }
    return settings
  }

  /**
   * Walk the whole chain to one peer and report which hop is broken.
   *
   * When something does not work, the useful question is never "is it broken"
   * but "which hop": the relay, the encrypted link, the peer's mesh API, the
   * peer's own `dsh web` port, this machine's proxy, or one forwarded port.
   * Each step is probed for real and timed, because a plausible-looking status
   * can still hide a dead socket (that is exactly what happened during
   * development more than once).
   * @param {string} peerId - Peer to diagnose.
   * @returns {Promise<{peerId: string, checks: Record<string, unknown>[], at: number}>} the report.
   */
  async function diagnosePeer(peerId) {
    const checks = []
    const peer = config.peers.find((entry) => entry.id === peerId)
    checks.push({
      name: '本机配置',
      ok: peer !== undefined,
      detail: peer === undefined
        ? '这台机器不在 peer 列表里'
        : `${peer.transport === 'direct' ? `直连 ${peer.host}:${peer.port}` : '经公网中继'}${peer.enabled === false ? '（已停用）' : ''}`,
    })

    if (config.relay.url === '') {
      checks.push({ name: '中继', ok: peer?.transport !== 'relay', detail: '本机没配中继' })
    } else {
      const status = mesh.relay?.status ?? 'disabled'
      checks.push({
        name: '中继',
        ok: status === 'online',
        detail: `${config.relay.url} · ${status}${mesh.relay?.lastError ? ` · ${mesh.relay.lastError}` : ''}`,
      })
    }

    const live = mesh.snapshotPeers().find((entry) => entry.id === peerId)
    checks.push({
      name: '加密链路',
      ok: live?.status === 'online',
      detail: live === undefined ? '没有这条 peer' : `${live.status}${live.error ? ` · ${live.error}` : ''}${live.connectedAt ? ` · 已连 ${Math.round((Date.now() - live.connectedAt) / 1000)}s` : ''}`,
    })

    const apiStart = Date.now()
    let apiOk = false
    let apiDetail = ''
    try {
      const pong = await mesh.call(peerId, 'ping', {}, { timeoutMs: 8000 })
      apiOk = isRecord(pong) && pong.pong === true
      apiDetail = `往返 ${Date.now() - apiStart}ms`
    } catch (error) {
      apiDetail = error instanceof Error ? error.message : String(error)
    }
    checks.push({ name: '远端 Mesh API', ok: apiOk, detail: apiDetail })

    const cached = snapshots.get(peerId)
    checks.push({
      name: '远端清单',
      ok: cached?.value !== undefined,
      detail: cached?.error ?? (cached?.value === undefined ? '还没读到（点「刷新」试试）' : `${cached.value.sessionCount ?? 0} 个对话 · ${(cached.value.workspaces ?? []).length} 个工作区`),
    })

    const webPort = asPort(cached?.value?.webPort)
    if (webPort === undefined) {
      checks.push({ name: '远端 dsh web 端口', ok: false, detail: '对端没有报告端口——那边大概率没在跑 `dsh web`' })
    } else {
      const start = Date.now()
      try {
        const stream = await mesh.stream(peerId, `127.0.0.1:${webPort}`, { timeoutMs: 8000 })
        stream.destroy()
        checks.push({ name: '远端 dsh web 端口', ok: true, detail: `127.0.0.1:${webPort} 可连 · ${Date.now() - start}ms` })
      } catch (error) {
        checks.push({ name: '远端 dsh web 端口', ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }

    const proxy = proxies.get(peerId)
    checks.push({
      name: '本机 GUI 代理',
      ok: proxy !== undefined,
      detail: proxy === undefined ? '还没开（点「打开远程 GUI」会开）' : `http://127.0.0.1:${proxy.port}/`,
    })

    for (const forward of config.forwards.filter((entry) => entry.peerId === peerId).slice(0, 5)) {
      const entry = forwarders.get(forward.id)
      const start = Date.now()
      try {
        const stream = await mesh.stream(peerId, `127.0.0.1:${forward.remotePort}`, { timeoutMs: 8000 })
        stream.destroy()
        checks.push({ name: `转发 ${forward.remotePort}`, ok: true, detail: `远端可连 → 本机 ${entry?.port ?? '未启动'} · ${Date.now() - start}ms` })
      } catch (error) {
        checks.push({ name: `转发 ${forward.remotePort}`, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }

    return { peerId, checks, at: Date.now() }
  }

  /**
   * Apply a peer list change and reconcile the mesh.
   * @returns {Promise<void>} resolves once the mesh caught up.
   */
  async function reconcile() {
    await mesh.setPeers(config.peers.map((peer) => ({ ...peer })))
    // Proxies and forwards follow their peer's lifecycle.
    for (const [peerId, entry] of [...proxies]) {
      if (config.peers.some((peer) => peer.id === peerId)) continue
      entry.server.close()
      entry.server.closeAllConnections?.()
      proxies.delete(peerId)
    }
  }

  /** Start the mesh and everything that depends on configuration. */
  async function start() {
    if (runtime.started) return
    runtime.started = true
    if (loaded.created) {
      log(`created ${configFile}`)
      log(`this machine is ${config.machine.id} (${config.machine.name}); add a peer or paste a pairing code from another machine`)
    }
    await mesh.start()
    await reconcile()
    for (const forward of config.forwards) {
      try {
        await ensureForward(forward)
      } catch (error) {
        log(`port forward ${forward.id} unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Bring back GUI proxies the operator has already opened once. The port and
    // the remote cookie that is bound to it both persist, so a stored bookmark
    // like http://127.0.0.1:34100/ would otherwise refuse the connection after
    // every harness restart until the button is clicked again.
    for (const peer of config.peers) {
      if (peer.enabled === false || asPort(peer.proxyPort) === undefined) continue
      try {
        await ensureProxy(peer.id)
      } catch (error) {
        log(`GUI proxy for ${peer.id} could not be restored: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    schedulePoll(500)
    log(`remote-workspaces ready as ${config.machine.id}${mesh.boundPort === 0 ? '' : ` (direct listener on ${config.listenHost}:${mesh.boundPort})`}`)
  }

  /** Tear everything down. */
  async function stop() {
    runtime.started = false
    clearTimeout(runtime.poller)
    for (const [, entry] of proxies) {
      entry.server.close()
      entry.server.closeAllConnections?.()
    }
    proxies.clear()
    for (const [, entry] of forwarders) {
      entry.server.close()
      entry.server.closeAllConnections?.()
    }
    forwarders.clear()
    await mesh.stop()
  }

  ctx.effect(() => {
    void start().catch((error) => log(`startup failed: ${error instanceof Error ? error.message : String(error)}`))
    return () => {
      void stop()
    }
  }, 'remote-workspaces: lifecycle')

  /**
   * Build the panel's view of the world.
   * @returns {Promise<Record<string, unknown>>} the state payload.
   */
  async function statePayload() {
    const peers = mesh.snapshotPeers().map((peer) => {
      const cached = snapshots.get(peer.id)
      const value = cached?.value
      return {
        ...peer,
        displayName: peer.name,
        proxyPort: config.peers.find((entry) => entry.id === peer.id)?.proxyPort ?? null,
        snapshotAt: cached?.at ?? null,
        snapshotError: cached?.error ?? null,
        machine: value?.machine ?? null,
        webPort: value?.webPort ?? null,
        workspaces: value?.workspaces ?? [],
        sessions: value?.sessions ?? [],
        sessionCount: value?.sessionCount ?? 0,
        runningCount: value?.runningCount ?? 0,
      }
    })
    const forwards = []
    for (const forward of config.forwards) {
      const entry = forwarders.get(forward.id)
      forwards.push({
        ...forward,
        localPort: entry?.port ?? forward.localPort ?? null,
        url: entry === undefined ? null : `http://127.0.0.1:${entry.port}/`,
        peerName: config.peers.find((peer) => peer.id === forward.peerId)?.name ?? forward.peerId,
      })
    }
    return {
      self: {
        id: config.machine.id,
        name: config.machine.name,
        hostname: os.hostname(),
        platform: process.platform,
        listenHost: config.listenHost,
        listenPort: mesh.boundPort || config.listenPort,
        webPort: ctx.webServer?.port ?? 0,
        relay: { url: config.relay.url, configured: config.relay.url !== '', ca: config.relay.ca ?? '', allowSelfSigned: config.relay.allowSelfSigned === true },
      },
      relayStatus: mesh.relay?.status ?? 'disabled',
      relayError: mesh.relay?.lastError ?? null,
      peers,
      forwards,
      pollMs: Number(config.pollMs ?? 20000),
      paths: { configFile, stateDir },
      logs: logs.slice(-60),
    }
  }

  /**
   * The browser-facing RPC surface. Every call arrives over the authenticated
   * `/remote-workspaces` channel, so it is already behind the Host/Origin fence
   * and the browser-session cookie.
   * @param {string} endpoint - Method name.
   * @param {unknown} payload - Method payload.
   * @returns {Promise<{ok: true, value: unknown}|{ok: false, error: {code: string, message: string, details: Record<string, unknown>}}>} the envelope.
   */
  async function handle(endpoint, payload) {
    const input = isRecord(payload) ? payload : {}
    try {
      switch (endpoint) {
        case 'state':
          return ok(await statePayload())
        case 'watch':
          runtime.watchers += 1
          runtime.lastWatchAt = Date.now()
          void pollAll(true)
          return ok(await statePayload())
        case 'unwatch':
          runtime.watchers = Math.max(0, runtime.watchers - 1)
          runtime.lastWatchAt = Date.now()
          return ok({ watched: runtime.watchers })
        case 'refresh':
          if (typeof input.peerId === 'string') await pollPeer(input.peerId, true)
          else await pollAll(true)
          return ok(await statePayload())
        case 'peer.add': {
          const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined
          if (id === undefined) throw new MeshError('config/peer', 'a peer needs the machine id shown on the other computer')
          if (config.peers.some((peer) => peer.id === id)) throw new MeshError('config/peer', `peer ${id} is already configured`)
          const transport = input.transport === 'direct' ? 'direct' : 'relay'
          if (transport === 'direct' && (typeof input.host !== 'string' || input.host === '')) {
            throw new MeshError('config/peer', 'a direct peer needs a host')
          }
          const port = asPort(input.port)
          if (transport === 'direct' && port === undefined) throw new MeshError('config/peer', 'a direct peer needs a port')
          config.peers.push({
            id,
            name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : id,
            transport,
            host: typeof input.host === 'string' ? input.host.trim() : '',
            port: port ?? 0,
            enabled: input.enabled !== false,
          })
          saveConfig()
          await reconcile()
          await pollPeer(id, true)
          return ok(await statePayload())
        }
        case 'peer.update': {
          const peer = config.peers.find((entry) => entry.id === input.id)
          if (peer === undefined) throw new MeshError('config/peer', `no peer named ${JSON.stringify(input.id)}`)
          if (typeof input.name === 'string' && input.name.trim() !== '') peer.name = input.name.trim()
          if (input.transport === 'direct' || input.transport === 'relay') peer.transport = input.transport
          if (typeof input.host === 'string') peer.host = input.host.trim()
          if (asPort(input.port) !== undefined) peer.port = asPort(input.port)
          if (typeof input.enabled === 'boolean') peer.enabled = input.enabled
          saveConfig()
          await reconcile()
          return ok(await statePayload())
        }
        case 'peer.remove': {
          const index = config.peers.findIndex((entry) => entry.id === input.id)
          if (index === -1) throw new MeshError('config/peer', `no peer named ${JSON.stringify(input.id)}`)
          config.peers.splice(index, 1)
          config.forwards = config.forwards.filter((forward) => forward.peerId !== input.id)
          snapshots.delete(String(input.id))
          saveConfig()
          await reconcile()
          return ok(await statePayload())
        }
        case 'settings.set': {
          if (typeof input.machineName === 'string' && input.machineName.trim() !== '') config.machine.name = input.machineName.trim()
          if (typeof input.relayUrl === 'string') config.relay.url = input.relayUrl.trim()
          if (typeof input.relaySecret === 'string' && input.relaySecret.trim() !== '') config.relay.secret = input.relaySecret.trim()
          if (typeof input.relayCa === 'string') config.relay.ca = input.relayCa.trim()
          if (typeof input.relayAllowSelfSigned === 'boolean') config.relay.allowSelfSigned = input.relayAllowSelfSigned
          if (typeof input.listenHost === 'string' && input.listenHost.trim() !== '') config.listenHost = input.listenHost.trim()
          if (asPort(input.listenPort) !== undefined) config.listenPort = asPort(input.listenPort)
          if (Number.isSafeInteger(input.pollMs) && input.pollMs >= 5000) config.pollMs = input.pollMs
          saveConfig()
          const relayChanged = typeof input.relayUrl === 'string' || typeof input.relaySecret === 'string'
            || typeof input.relayCa === 'string' || typeof input.relayAllowSelfSigned === 'boolean'
          if (relayChanged) {
            await mesh.stop()
            mesh.relayConfig = relaySettings()
            runtime.started = false
            await start()
          }
          return ok(await statePayload())
        }
        case 'open.peer': {
          const peerId = String(input.peerId ?? '')
          await pollPeer(peerId, true)
          const address = await ensureProxy(peerId)
          // The token is fetched here, and only here: opening the remote GUI is
          // the one action that needs it.
          const token = await fetchLaunchToken(peerId)
          return ok(describeProxy(peerId, address.port, token))
        }
        case 'agent.prompt': {
          const peerId = String(input.peerId ?? '')
          const text = typeof input.text === 'string' ? input.text.trim() : ''
          if (text === '') throw new MeshError('api/request', 'write what the remote agent should do first')
          const answer = await mesh.call(peerId, 'agent.prompt', {
            ...(typeof input.sessionId === 'string' && input.sessionId !== '' ? { sessionId: input.sessionId } : {}),
            ...(typeof input.cwd === 'string' && input.cwd !== '' ? { cwd: input.cwd } : {}),
            ...(typeof input.workspaceId === 'string' && input.workspaceId !== '' ? { workspaceId: input.workspaceId } : {}),
            text,
            mode: input.mode === 'steer' ? 'steer' : 'queue',
          }, { timeoutMs: 30000 })
          void pollPeer(peerId, true)
          return ok({ ...(isRecord(answer) ? answer : {}), state: await statePayload() })
        }
        case 'agent.create': {
          const peerId = String(input.peerId ?? '')
          const answer = await mesh.call(peerId, 'agent.create', {
            ...(typeof input.cwd === 'string' && input.cwd !== '' ? { cwd: input.cwd } : {}),
          }, { timeoutMs: 30000 })
          void pollPeer(peerId, true)
          return ok({ ...(isRecord(answer) ? answer : {}), state: await statePayload() })
        }
        case 'diagnose': {
          const peerId = String(input.peerId ?? '')
          if (!config.peers.some((peer) => peer.id === peerId)) {
            throw new MeshError('config/peer', `no peer named ${JSON.stringify(peerId)}`)
          }
          return ok(await diagnosePeer(peerId))
        }
        case 'conversation': {
          const peerId = String(input.peerId ?? '')
          const sessionId = String(input.sessionId ?? '')
          if (sessionId === '') throw new MeshError('api/request', 'a conversation read needs a session id')
          const answer = await mesh.call(peerId, 'conversation', {
            sessionId,
            ...(Number.isSafeInteger(input.limit) ? { limit: input.limit } : {}),
          }, { timeoutMs: 30000 })
          return ok(isRecord(answer) ? answer : {})
        }
        case 'forward.add': {
          const peerId = String(input.peerId ?? '')
          if (!config.peers.some((peer) => peer.id === peerId)) throw new MeshError('config/forward', `no peer named ${JSON.stringify(peerId)}`)
          const remotePort = asPort(input.remotePort)
          if (remotePort === undefined) throw new MeshError('config/forward', 'a forward needs a remote port')
          const forward = {
            id: randomUUID(),
            peerId,
            remotePort,
            localPort: asPort(input.localPort) ?? 0,
            label: typeof input.label === 'string' ? input.label.trim() : '',
          }
          config.forwards.push(forward)
          saveConfig()
          const address = await ensureForward(forward)
          return ok({ forward: { ...forward, localPort: address.port }, url: address.url, state: await statePayload() })
        }
        case 'forward.remove': {
          const index = config.forwards.findIndex((entry) => entry.id === input.id)
          if (index === -1) throw new MeshError('config/forward', `no forward named ${JSON.stringify(input.id)}`)
          const [removed] = config.forwards.splice(index, 1)
          const entry = forwarders.get(removed.id)
          if (entry !== undefined) {
            entry.server.close()
            entry.server.closeAllConnections?.()
            forwarders.delete(removed.id)
          }
          saveConfig()
          return ok(await statePayload())
        }
        case 'pair.create': {
          const blob = {
            v: 1,
            from: { id: config.machine.id, name: config.machine.name, listenHost: config.listenHost, listenPort: mesh.boundPort || config.listenPort },
            clusterKey: config.clusterKey,
            relay: { url: config.relay.url, secret: config.relay.secret },
          }
          return ok({ code: Buffer.from(JSON.stringify(blob), 'utf8').toString('base64url'), from: blob.from })
        }
        case 'pair.accept': {
          const raw = Buffer.from(String(input.code ?? ''), 'base64url').toString('utf8')
          const blob = JSON.parse(raw)
          if (!isRecord(blob) || blob.v !== 1 || !isRecord(blob.from)) throw new MeshError('config/pair', 'that pairing code is not readable')
          if (typeof blob.clusterKey !== 'string' || blob.clusterKey === '') throw new MeshError('config/pair', 'the pairing code carries no cluster key')
          const before = config.clusterKey
          config.clusterKey = blob.clusterKey
          if (isRecord(blob.relay) && typeof blob.relay.url === 'string') {
            config.relay.url = blob.relay.url
            if (typeof blob.relay.secret === 'string' && blob.relay.secret !== '') config.relay.secret = blob.relay.secret
          }
          const fromId = String(blob.from.id ?? '')
          if (fromId !== '' && !config.peers.some((peer) => peer.id === fromId)) {
            config.peers.push({
              id: fromId,
              name: typeof blob.from.name === 'string' ? blob.from.name : fromId,
              transport: config.relay.url === '' ? 'direct' : 'relay',
              host: typeof blob.from.listenHost === 'string' ? blob.from.listenHost : '',
              port: asPort(blob.from.listenPort) ?? 0,
              enabled: true,
            })
          }
          saveConfig()
          if (before !== config.clusterKey) log('cluster key adopted from a pairing code; the mesh is restarting')
          await mesh.stop()
          config.clusterKey = blob.clusterKey
          mesh.clusterKey = Buffer.from(config.clusterKey, 'base64url')
          mesh.relayConfig = relaySettings()
          runtime.started = false
          await start()

          // A pairing code carries one direction: this machine now knows the
          // other one, but the other one has never heard of this machine. Tell
          // it, so a single paste really does join both ends. The link is
          // authenticated with the cluster secret the code just installed, so
          // the announcing peer id is trustworthy.
          let announced = false
          let announceError
          if (fromId !== '') {
            try {
              await mesh.call(fromId, 'pair.announce', {
                name: config.machine.name,
                listenHost: config.listenHost,
                listenPort: mesh.boundPort || config.listenPort,
                platform: process.platform,
              }, { timeoutMs: 15000 })
              announced = true
              log(`told ${fromId} about this machine; pairing is now mutual`)
            } catch (error) {
              announceError = error instanceof Error ? error.message : String(error)
              log(`could not reach ${fromId} to complete the pairing: ${announceError}`)
            }
            // Fetch the other side's workspaces and conversations now, so the
            // panel has something to show the moment it is opened.
            void pollPeer(fromId, true)
          }
          return ok({ ...(await statePayload()), announced, announceError })
        }
        case 'logs':
          return ok({ logs })
        default:
          throw new MeshError('api/unknown-op', `unknown remote-workspaces method ${JSON.stringify(endpoint)}`)
      }
    } catch (error) {
      const failure = error instanceof MeshError ? error : new MeshError('api/failure', error instanceof Error ? error.message : String(error))
      return { ok: false, error: { code: failure.code, message: failure.message, details: failure.details ?? {} } }
    }
  }

  /**
   * Register the browser-facing endpoint.
   *
   * Two carriers speak the same wire contract, and the browser half always
   * posts the same envelope to `/remote-workspaces/<method>`:
   *
   *   1. Connection's generic RPC channel, which puts the Host/Origin fence and
   *      the browser-session cookie in front of every call. It is tried first
   *      because it is the Harness's own gate.
   *   2. A prefix route on the raw webserver. It is the carrier this plugin
   *      falls back to when the Connection service is not composed or refuses
   *      the channel, and it enforces the same loopback socket + Host + Origin
   *      checks plus a per-process boot token handed to the page through an
   *      index injection.
   * @returns {boolean} whether some endpoint was installed.
   */
  function registerChannel() {
    bootToken = randomBytes(32).toString('base64url')
    try {
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: GLOBAL_NAME, value: { token: bootToken, channel: CHANNEL } })
      })
    } catch (error) {
      log(`cannot publish the boot token to the page: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Attempt 1: the Harness's own authenticated channel. The method must be
    // invoked on the service object itself — an extracted reference loses the
    // Cordis binding and fails with "cannot get property ... without inject".
    try {
      if (typeof ctx.connection?.rpc?.handle !== 'function') throw new Error('ctx.connection.rpc.handle is unavailable')
      ctx.connection.rpc.handle(CHANNEL, (endpoint, payload) => handle(endpoint, payload))
      log('browser endpoint registered on the authenticated Connection RPC channel')
      return true
    } catch (error) {
      log(`Connection RPC channel unavailable (${error instanceof Error ? error.message : String(error)}); using the loopback-guarded webserver route instead`)
    }

    // Attempt 2: the raw webserver route, guarded by this plugin.
    try {
      if (typeof ctx.webServer?.register !== 'function') throw new Error('ctx.webServer.register is unavailable')
      ctx.effect(
        () => ctx.webServer.register({ kind: 'prefix', path: CHANNEL, handler: rawChannel }),
        'remote-workspaces: remote-workspaces route',
      )
      log('browser endpoint registered as a loopback-guarded webserver route')
      return true
    } catch (error) {
      log(`cannot register the remote-workspaces endpoint at all: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * The fallback carrier: the same request/response envelope Connection uses,
   * served straight off the webserver for a loopback, same-origin caller that
   * also presents this process's boot token.
   * @param {import('node:http').IncomingMessage} request - HTTP request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @returns {Promise<void>} resolves once the response is written.
   */
  async function rawChannel(request, response) {
    if (!isLoopbackRequest(request)) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('forbidden')
      return
    }
    const presented = request.headers[TOKEN_HEADER]
    if (typeof presented !== 'string' || !timingSafeEqualText(presented, bootToken)) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const endpoint = url.pathname.slice(CHANNEL.length + 1)
    if (request.method !== 'POST' || endpoint === '') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      response.writeHead(415, { 'content-type': 'text/plain' })
      response.end('content type must be application/json')
      return
    }
    let envelope
    try {
      envelope = JSON.parse((await readBody(request)).toString('utf8'))
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('body is not JSON')
      return
    }
    const rpcId = isRecord(envelope) && typeof envelope.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
    const result = await handle(endpoint, isRecord(envelope) ? envelope.payload : undefined)
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }

  registerChannel()
}

/**
 * @param {unknown} value - Successful value.
 * @returns {{ok: true, value: unknown}} the success envelope.
 */
function ok(value) {
  return { ok: true, value }
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * @param {string|undefined} address - Socket peer address.
 * @returns {boolean} whether it names the loopback range.
 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/**
 * Request-level trust fence for the fallback carrier: a loopback socket address
 * AND a loopback `Host`, plus the same browser same-origin markers the built-in
 * fence checks. The socket address is authoritative; `X-Forwarded-For` is never
 * trusted.
 * @param {import('node:http').IncomingMessage} request - HTTP request.
 * @returns {boolean} whether the request may be served.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return false
  }
  const name = authority.hostname.toLowerCase()
  if (!(name === 'localhost' || name === '[::1]' || name === '::1' || isIPv4Loopback(name))) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}

/**
 * Flatten one message's content parts into display text.
 * @param {unknown} content - A message content array.
 * @returns {string} the concatenated text parts.
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (isRecord(part) && part.type === 'image') parts.push('[图片]')
    else if (isRecord(part) && part.type === 'file') parts.push('[文件]')
  }
  return parts.join('\n').trim()
}

/**
 * Constant-time comparison of two text tokens.
 * @param {string} candidate - Value presented by the caller.
 * @param {string} expected - Value this process minted.
 * @returns {boolean} whether they match.
 */
function timingSafeEqualText(candidate, expected) {
  if (expected === '' || candidate.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request - HTTP request.
 * @returns {Promise<Buffer>} the collected body.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > 1024 * 1024) {
        reject(new MeshError('api/size', 'request body exceeds the size limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export { delay }
