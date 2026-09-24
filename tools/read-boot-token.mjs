#!/usr/bin/env node
/**
 * Read a running instance's plugin boot token without a browser.
 *
 * The plugin's host half hands the page a per-process token and refuses every
 * request that does not present it. That is deliberate, but it makes the
 * headless tools awkward: `e2e-two-node.mjs` needs the token, and reading it
 * out of a devtools console means opening a GUI you were trying to avoid.
 *
 * The token is injected into the served index HTML, so two plain requests are
 * enough: the launch URL exchanges `?token=…` for a cookie, and the page that
 * comes back carries `globalThis["__DSH_REMOTE_MESH__"]`.
 *
 * Usage:
 *   node tools/read-boot-token.mjs --port 3080 --launch-token <t>
 *   node tools/read-boot-token.mjs --url 'http://127.0.0.1:3080/?token=<t>'
 * @module dsh-remote-mesh/tools/read-boot-token
 */
import http from 'node:http'
import process from 'node:process'

const GLOBAL_NAME = '__DSH_REMOTE_MESH__'

/**
 * @param {string[]} argv - Arguments after the script name.
 * @returns {Record<string, string>} parsed `--flag value` pairs.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    out[token.slice(2)] = argv[index + 1] ?? ''
    index += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const fromUrl = typeof args.url === 'string' && args.url !== '' ? new URL(args.url) : undefined
const port = fromUrl ? Number(fromUrl.port) : Number(args.port ?? 3080)
const launchToken = fromUrl ? fromUrl.searchParams.get('token') ?? '' : String(args['launch-token'] ?? '')

if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write('read-boot-token: pass --port <n> (or a full --url) with a valid port\n')
  process.exit(2)
}
if (launchToken === '') {
  process.stderr.write('read-boot-token: pass --launch-token <t> (the value printed by `dsh web`), or --url\n')
  process.exit(2)
}

/**
 * @param {string} path - Request path.
 * @param {string} cookie - Cookie header, empty on the first hop.
 * @returns {Promise<{status: number, location?: string, cookie: string, body: string}>} the response.
 */
function request(path, cookie) {
  return new Promise((resolve) => {
    const call = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: cookie === '' ? {} : { cookie } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            cookie: (response.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; '),
            body,
          }),
        )
      },
    )
    call.on('error', (error) => {
      process.stderr.write(`read-boot-token: ${error.code ?? 'error'} ${error.message}\n`)
      process.exit(1)
    })
    call.end()
  })
}

const first = await request(`/?token=${encodeURIComponent(launchToken)}`, '')
// 303 (or 302) is the token-for-cookie exchange; a 200 here means the instance
// already had a session and served the app straight away.
const page = first.status === 200 ? first : await request('/', first.cookie)
const match = new RegExp(`${GLOBAL_NAME}[^=]*= *(\\{[^<]*\\})`).exec(page.body)
if (match === null) {
  process.stderr.write(
    `read-boot-token: the page did not carry ${GLOBAL_NAME} — the plugin is probably not loaded\n`,
  )
  process.exit(1)
}
let parsed
try {
  parsed = JSON.parse(match[1])
} catch (error) {
  process.stderr.write(`read-boot-token: cannot parse the injected value (${error.message})\n`)
  process.exit(1)
}
if (typeof parsed.token !== 'string' || parsed.token === '') {
  process.stderr.write('read-boot-token: the injected value carried no token\n')
  process.exit(1)
}
process.stdout.write(args.quiet === '' || args.quiet === undefined ? `${parsed.token}\n` : `${parsed.token}\n`)
process.stderr.write(`channel: ${parsed.channel}\n`)
