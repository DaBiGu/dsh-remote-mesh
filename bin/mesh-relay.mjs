#!/usr/bin/env node
/**
 * dsh-remote-mesh relay.
 *
 * A blind virtual-circuit switch for the remote workspace mesh. Every node
 * holds one outbound WebSocket to this process and the relay pairs circuits
 * between them, so two machines behind different NATs can reach each other
 * through a server that already serves TLS.
 *
 * The relay never sees plaintext. Frame headers carry only a peer id and a
 * circuit id; tunnel targets, DSH launch tokens, file bytes and conversation
 * content are all sealed by the two endpoints with a key the relay does not
 * have. Running this on a machine you do not trust costs you metadata
 * (who talks to whom, how much, when) and nothing else.
 *
 * Usage:
 *   MESH_RELAY_SECRET='<long random string>' node bin/mesh-relay.mjs
 *   node bin/mesh-relay.mjs --secret '<...>' --port 8787 --host 127.0.0.1
 *
 * Behind nginx (TLS terminated by the proxy, WebSocket upgrade forwarded):
 *   location /__dsh-mesh/relay {
 *     proxy_pass          http://127.0.0.1:8787/;
 *     proxy_http_version  1.1;
 *     proxy_set_header    Upgrade $http_upgrade;
 *     proxy_set_header    Connection "upgrade";
 *     proxy_set_header    Host $host;
 *     proxy_read_timeout  3600s;
 *     proxy_send_timeout  3600s;
 *     proxy_buffering     off;
 *   }
 * @module dsh-remote-mesh/bin/mesh-relay
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { attachWebSocketServer } from '../lib/core/ws.js'
import { CLOSE, DATA, ERROR, INCOMING, OPEN, PING, REGISTER, RelayFrameParser, encodeRelayFrame, relayTypeName } from '../lib/core/relay-wire.js'
import { verifyRelayToken } from '../lib/core/transport.js'

/**
 * @param {string[]} argv - Process arguments.
 * @returns {Record<string, string>} parsed `--flag value` pairs.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true'
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const secret = args.secret ?? process.env.MESH_RELAY_SECRET ?? ''
const port = Number(args.port ?? process.env.MESH_RELAY_PORT ?? 8787)
const host = args.host ?? process.env.MESH_RELAY_HOST ?? '127.0.0.1'
const path = args.path ?? process.env.MESH_RELAY_PATH ?? '/'
const verbose = args.verbose === 'true' || process.env.MESH_RELAY_VERBOSE === '1'

if (secret.length < 16) {
  process.stderr.write('dsh-mesh-relay: MESH_RELAY_SECRET must be at least 16 characters.\n')
  process.stderr.write('  generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"\n')
  process.exit(2)
}

const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`)

/** @type {Map<string, {ws: import('../lib/core/ws.js').WebSocketDuplex, id: string}>} */
const nodes = new Map()
/** @type {Map<number, {from: string, to: string}>} */
const circuits = new Map()

const server = http.createServer((request, response) => {
  if (request.url === '/healthz' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, service: 'dsh-remote-mesh-relay', nodes: nodes.size, circuits: circuits.size }))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not found')
})

attachWebSocketServer(server, {
  path,
  onConnection: (ws) => {
    const parser = new RelayFrameParser()
    /** @type {string|undefined} */
    let identity
    let registered = false

    const send = (type, header, payload) => {
      if (ws.destroyed || ws.isClosed) return
      ws.write(encodeRelayFrame(type, header, payload))
    }

    const forward = (socket, type, header, payload) => {
      if (socket === undefined || socket.destroyed || socket.isClosed) return false
      socket.write(encodeRelayFrame(type, header, payload))
      return true
    }

    const dropCircuits = () => {
      for (const [cid, circuit] of [...circuits]) {
        if (circuit.from !== identity && circuit.to !== identity) continue
        circuits.delete(cid)
        const other = circuit.from === identity ? circuit.to : circuit.from
        forward(nodes.get(other)?.ws, CLOSE, { cid })
      }
    }

    ws.on('data', (chunk) => {
      let frames
      try {
        frames = parser.push(chunk)
      } catch (error) {
        if (verbose) log(`node ${identity ?? '?'} sent a malformed frame: ${error.message}`)
        ws.destroy()
        return
      }
      for (const frame of frames) {
        if (!registered && frame.type !== REGISTER) {
          send(ERROR, { reason: 'register first' })
          ws.destroy()
          return
        }
        switch (frame.type) {
          case REGISTER: {
            const id = String(frame.header.id ?? '')
            if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || !verifyRelayToken(secret, id, frame.header.token)) {
              log(`refused registration as ${JSON.stringify(id)}: bad identity or token`)
              send(ERROR, { reason: 'registration refused' })
              ws.destroy()
              return
            }
            const existing = nodes.get(id)
            if (existing !== undefined && existing.ws !== ws) {
              existing.ws.destroy()
              log(`node ${id} reconnected; the previous socket was closed`)
            }
            identity = id
            registered = true
            nodes.set(id, { ws, id })
            send(PING, {})
            log(`node ${id} online (${nodes.size} online)`)
            return
          }
          case OPEN: {
            const to = String(frame.header.to ?? '')
            const cid = Number(frame.header.cid)
            if (!Number.isSafeInteger(cid) || cid <= 0) {
              send(ERROR, { reason: 'invalid circuit id' })
              return
            }
            if (circuits.has(cid)) {
              send(ERROR, { cid, reason: 'circuit id collision' })
              return
            }
            const target = nodes.get(to)
            if (target === undefined) {
              send(ERROR, { cid, reason: `node ${to} is not online` })
              return
            }
            circuits.set(cid, { from: identity, to })
            if (!forward(target.ws, INCOMING, { from: identity, cid })) {
              circuits.delete(cid)
              send(ERROR, { cid, reason: `node ${to} went offline` })
              return
            }
            send(OPEN, { cid })
            if (verbose) log(`circuit ${cid} opened ${identity} -> ${to}`)
            return
          }
          case DATA: {
            const cid = Number(frame.header.cid)
            const circuit = circuits.get(cid)
            if (circuit === undefined) return
            const other = circuit.from === identity ? circuit.to : circuit.from
            if (!forward(nodes.get(other)?.ws, DATA, { cid }, frame.payload)) circuits.delete(cid)
            return
          }
          case CLOSE: {
            const cid = Number(frame.header.cid)
            const circuit = circuits.get(cid)
            if (circuit === undefined) return
            circuits.delete(cid)
            const other = circuit.from === identity ? circuit.to : circuit.from
            forward(nodes.get(other)?.ws, CLOSE, { cid })
            if (verbose) log(`circuit ${cid} closed`)
            return
          }
          case PING:
            send(PING, {})
            return
          default:
            if (verbose) log(`node ${identity} sent ${relayTypeName(frame.type)}, ignored`)
        }
      }
    })

    ws.on('close', () => {
      if (identity === undefined) return
      if (nodes.get(identity)?.ws !== ws) return
      nodes.delete(identity)
      dropCircuits()
      log(`node ${identity} offline (${nodes.size} online)`)
    })
    ws.on('error', () => {
      /* the close handler owns cleanup */
    })
  },
})

server.listen(port, host, () => {
  log(`dsh-remote-mesh relay listening on ws://${host}:${port}${path}`)
  log(`session ${randomUUID()}`)
  if (host === '127.0.0.1' || host === 'localhost') {
    log('bound to loopback: publish it through your reverse proxy with the WebSocket upgrade headers documented at the top of this file')
  }
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown() {
  log('shutting down')
  for (const [, node] of nodes) node.ws.destroy()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
