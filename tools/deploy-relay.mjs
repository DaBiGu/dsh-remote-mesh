#!/usr/bin/env node
/**
 * Deploy the relay on the machine that fronts it (your public-IP server).
 *
 * The relay itself is one file with no dependencies, so the only delicate part
 * is adding one `location` block to a production nginx config that also serves
 * your other sites. This script makes that step reversible and fail-closed:
 *
 *   1. it edits only a marked region inside the TLS `server` block for the
 *      domain you name — never another vhost, never another file,
 *   2. it writes a timestamped backup before touching anything,
 *   3. it runs `nginx -t` and **only reloads when the test passes**,
 *   4. if the test fails it restores the backup immediately, re-tests, and
 *      reports exactly where the backup lives,
 *   5. it then starts the relay and proves the public wss:// endpoint answers.
 *
 * Nothing is edited in `plan` mode, which is the mode to run first.
 *
 *   node tools/deploy-relay.mjs plan     --domain shop.example.com
 *   node tools/deploy-relay.mjs apply    --domain shop.example.com
 *   node tools/deploy-relay.mjs status   --domain shop.example.com
 *   node tools/deploy-relay.mjs chain    --domain shop.example.com
 *   node tools/deploy-relay.mjs rollback --domain shop.example.com
 *
 * `chain` is the odd one out: it talks to the endpoint over TLS from wherever
 * you run it and reports how many certificates the server actually sends. Use
 * it when browsers reach the site but the plugin cannot — a missing
 * intermediate only shows up for strict clients like Node.
 * @module dsh-remote-workspaces/tools/deploy-relay
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import {
  buildSnippet,
  findServerBlock,
  hasForeignLocation,
  hasManagedBlock,
  insertManagedBlock,
  removeManagedBlock,
} from './nginx-edit.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RELAY_DIR = path.resolve(HERE, '..')

/**
 * @param {string[]} argv - Arguments after the subcommand.
 * @returns {Record<string, string|boolean>} parsed `--flag value` / `--flag` pairs.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const [command = 'plan', ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
const domain = typeof args.domain === 'string' ? args.domain : ''
const location = typeof args.location === 'string' ? args.location : '/__dsh-mesh/relay'
const relayPort = Number(args['relay-port'] ?? 8787)
/** Where the relay's own files (secret, pid, logs) live; overridable for tests. */
const relayDir = typeof args['relay-dir'] === 'string' ? path.resolve(args['relay-dir']) : DEFAULT_RELAY_DIR
const healthPath = '/healthz'
/** Port the public URL is served on; empty means the scheme default. */
const publicPort = asPublicPort(args['public-port'])
const log = (message) => process.stdout.write(`${message}\n`)

// `snippet` never touches a live install and `stop` only signals a process, so
// neither needs a domain. `status` accepts one but can report without it.
const domainOptional = command === 'snippet' || command === 'stop' || command === 'status' || command === 'chain'
if (!domainOptional && domain === '') {
  process.stderr.write('deploy-relay: --domain <name> is required (the vhost whose certificate should front the relay)\n')
  process.stderr.write('  example: node tools/deploy-relay.mjs plan --domain shop.example.com\n')
  process.exit(2)
}

/**
 * @param {unknown} value - Candidate port from the command line.
 * @returns {string} an empty string, or `:port` when a valid port was given.
 */
function asPublicPort(value) {
  if (value === undefined || value === true) return ''
  const port = Number(value)
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? `:${port}` : ''
}

/**
 * @param {string} domain - Public host name.
 * @param {string} location - Relay location path.
 * @param {string} healthPath - Health path under the location.
 * @returns {string} the URL to probe.
 */
function publicUrl(domain, location, healthPath) {
  return `https://${domain}${publicPort}${location}${healthPath}`
}

/**
 * @param {string} file - File whose leading indentation of `line` to read.
 * @param {number} line - 1-based line number.
 * @returns {string} the line's text.
 */
function lineAt(file, line) {
  return readFileSync(file, 'utf8').split('\n')[line - 1] ?? ''
}

/**
 * Locate nginx and the config it actually loads.
 * @returns {{exe: string, prefix: string, conf: string}} the resolved paths.
 */
function locateNginx() {
  let exe = typeof args.nginx === 'string' ? args.nginx : ''
  if (exe === '') {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['nginx'], { encoding: 'utf8' })
    if (found.status === 0) exe = found.stdout.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? ''
  }
  for (const guess of ['C:\\nginx\\nginx.exe', 'C:\\tools\\nginx\\nginx.exe', 'C:\\Program Files\\nginx\\nginx.exe']) {
    if (exe === '' && existsSync(guess)) exe = guess
  }
  if (exe === '' || !existsSync(exe)) {
    throw new Error('cannot find nginx; pass --nginx <path to nginx.exe>')
  }
  const prefix = path.dirname(exe)
  let conf = typeof args.conf === 'string' ? args.conf : ''
  if (conf === '') {
    const version = spawnSync(exe, ['-V'], { encoding: 'utf8', cwd: prefix })
    const text = `${version.stdout ?? ''}${version.stderr ?? ''}`
    const match = /--conf-path=(\S+)/.exec(text)
    const prefixArg = /--prefix=(\S+)/.exec(text)
    const confFromArgs = match === null ? 'conf/nginx.conf' : match[1]
    const prefixFromArgs = prefixArg === null ? prefix : prefixArg[1].replace(/["']/g, '')
    conf = path.isAbsolute(confFromArgs) ? confFromArgs : path.join(prefixFromArgs, confFromArgs)
  }
  return { exe, prefix, conf }
}

/**
 * Some installs wrap nginx in a `.cmd`/`.bat`; those need a shell to run.
 * @param {string} exe - Resolved nginx executable.
 * @returns {boolean} whether the command should run through a shell.
 */
function needsShell(exe) {
  return /\.(cmd|bat)$/i.test(exe)
}

/**
 * Run `nginx -t` and return its verdict.
 * @param {{exe: string, prefix: string}} nginx - Resolved nginx.
 * @returns {{ok: boolean, output: string}} the test result.
 */
function nginxTest(nginx) {
  const result = spawnSync(nginx.exe, ['-t'], { encoding: 'utf8', cwd: nginx.prefix, shell: needsShell(nginx.exe) })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0, output }
}

/**
 * Reload nginx.
 * @param {{exe: string, prefix: string}} nginx - Resolved nginx.
 * @returns {{ok: boolean, output: string}} the reload result.
 */
function nginxReload(nginx) {
  const result = spawnSync(nginx.exe, ['-s', 'reload'], { encoding: 'utf8', cwd: nginx.prefix, shell: needsShell(nginx.exe) })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0, output }
}

/**
 * @param {number} port - Loopback port.
 * @returns {Promise<boolean>} whether something is listening there.
 */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), 1500).unref()
  })
}

/**
 * Read the relay secret, creating one on first use.
 * @returns {string} the shared relay secret.
 */
function relaySecret() {
  if (typeof args.secret === 'string' && args.secret !== '') return args.secret
  const file = path.join(relayDir, 'relay-secret.txt')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const created = spawnSync(process.execPath, ['-e', "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(file, created, { encoding: 'utf8', mode: 0o600 })
  log(`generated a relay secret and wrote it to ${file}`)
  return created
}

/**
 * Start the relay detached, unless the port is already taken.
 * @returns {Promise<{started: boolean, pid?: number}>} what happened.
 */
async function startRelay() {
  if (await isListening(relayPort)) {
    log(`the relay is already listening on 127.0.0.1:${relayPort}`)
    return { started: false }
  }
  const secret = relaySecret()
  const out = path.join(relayDir, 'relay.out.log')
  const err = path.join(relayDir, 'relay.err.log')
  // The relay *code* travels with this script; only its state (secret, pid,
  // logs) belongs in the configurable directory.
  const entry = path.join(DEFAULT_RELAY_DIR, 'bin', 'mesh-relay.mjs')
  if (!existsSync(entry)) throw new Error(`cannot find ${entry}`)
  mkdirSync(relayDir, { recursive: true })
  const child = spawn(process.execPath, [entry, '--port', String(relayPort), '--host', '127.0.0.1'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, MESH_RELAY_SECRET: secret },
  })
  child.unref()
  writeFileSync(path.join(relayDir, 'relay.pid'), `${child.pid}\n`, 'utf8')
  writeFileSync(out, `started ${new Date().toISOString()} pid ${child.pid}\n`, { encoding: 'utf8', flag: 'a' })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (await isListening(relayPort)) {
      log(`relay started (pid ${child.pid}) listening on 127.0.0.1:${relayPort}`)
      return { started: true, pid: child.pid }
    }
  }
  throw new Error(`the relay did not start listening on ${relayPort}; check ${err}`)
}

/**
 * Stop a relay this script started.
 * @returns {boolean} whether a process was signalled.
 */
function stopRelay() {
  const pidFile = path.join(relayDir, 'relay.pid')
  if (!existsSync(pidFile)) {
    log('no relay.pid here, so this script did not start a relay; stop it however you started it')
    return false
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    log(`relay.pid does not hold a pid (${String(readFileSync(pidFile, 'utf8')).trim()})`)
    return false
  }
  try {
    process.kill(pid)
    writeFileSync(pidFile, '', 'utf8')
    log(`signalled relay pid ${pid} to stop`)
    return true
  } catch (error) {
    log(`could not signal pid ${pid}: ${error.message}`)
    return false
  }
}

/**
 * Ask the public wss endpoint whether it is alive.
 * @param {string} url - `https://.../healthz`.
 * @param {boolean} insecure - Skip certificate validation.
 * @returns {Promise<{ok: boolean, detail: string}>} the probe result.
 */
function probe(url, insecure) {
  return new Promise((resolve) => {
    const request = https.get(url, { rejectUnauthorized: !insecure, timeout: 12000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        resolve({ ok: response.statusCode === 200 && body.includes('dsh-remote-workspaces-relay'), detail: `HTTP ${response.statusCode} ${body.slice(0, 160)}` })
      })
    })
    request.on('timeout', () => {
      request.destroy()
      resolve({ ok: false, detail: 'timed out' })
    })
    request.on('error', (error) => resolve({ ok: false, detail: `${error.code ?? 'error'} ${error.message}`.trim() }))
  })
}

/**
 * Probe a URL, retrying while nginx finishes taking the new config.
 *
 * `nginx -s reload` returns as soon as the signal is delivered: the old worker
 * keeps answering for a moment afterwards. Probing exactly once right after a
 * reload therefore reports a failure that is really just a race — observed
 * against a real nginx, where the first request after `apply` hit the previous
 * config and answered 404 while the deployment itself was perfectly healthy.
 * @param {string} url - `https://.../healthz`.
 * @param {boolean} insecure - Skip certificate validation.
 * @param {number} [timeoutMs] - How long to keep retrying.
 * @returns {Promise<{ok: boolean, detail: string, attempts: number}>} the result.
 */
async function probeEventually(url, insecure, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let result = await probe(url, insecure)
  let attempts = 1
  while (!result.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    result = await probe(url, insecure)
    attempts += 1
  }
  return { ...result, attempts }
}

/**
 * Explain a certificate-chain failure, which routing advice would misdiagnose.
 *
 * Found on a real server: nginx served only the leaf certificate. Browsers and
 * curl fill the gap in via AIA, so the site looks perfectly healthy, but Node
 * refuses with `unable to verify the first certificate` — and the plugin's
 * `wss://` client is Node. The generic advice ("check the A record") sends you
 * looking in the wrong place.
 * @param {string} detail - Probe failure text.
 * @returns {string[]} lines to print, empty when the failure is not chain-shaped.
 */
function chainHint(detail) {
  if (!/unable to verify|UNABLE_TO_VERIFY|self.signed|CERT_/i.test(detail)) return []
  return [
    'That error points at the certificate CHAIN, not at routing:',
    '  - browsers and curl hide a missing intermediate by fetching it over AIA;',
    '  - Node does not, and the plugin runs on Node.',
    'If the server sends only the leaf, this probe fails while the site loads fine in a browser.',
    'Fix: make nginx send the full chain — point ssl_certificate at the file that starts with',
    'the leaf and continues into the intermediate (Certify The Web keeps both; the one you want',
    'is the *-fullchain style file, not the bare leaf).',
    'Confirm with:  openssl s_client -connect <host>:443 -servername <domain> -showcerts',
    '  "certificates sent" must be 2 or more. One means the intermediate is missing.',
    'Until then the plugin needs relay.ca pointed at the chain (or allowSelfSigned).',
  ]
}

/**
 * Ask a TLS server what it actually sends: how many certificates, which names
 * they cover, and whether Node's own trust accepts the result.
 *
 * This exists because "the site loads in my browser" and "the plugin can open a
 * wss:// link to it" are different questions. Browsers paper over a missing
 * intermediate by fetching it over AIA; Node refuses.
 * @param {string} host - Host or IP to connect to.
 * @param {number} port - TLS port.
 * @param {string} servername - SNI name.
 * @returns {Promise<Record<string, unknown>>} the findings, or `{error}`.
 */
function inspectChain(host, port, servername) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: 12000 })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.once('secureConnect', () => {
      const leaf = socket.getPeerCertificate(true)
      const names = []
      const seen = new Set()
      let current = leaf
      while (current && current.raw && current.fingerprint && !seen.has(current.fingerprint)) {
        seen.add(current.fingerprint)
        names.push((current.subject && current.subject.CN) || '(no CN)')
        if (current.issuerCertificate === current) break
        current = current.issuerCertificate
      }
      done({
        sent: seen.size,
        names,
        subject: leaf.subject ?? null,
        issuer: leaf.issuer ?? null,
        altnames: leaf.subjectaltname ?? '',
        validTo: leaf.valid_to ?? '',
        authorized: socket.authorized === true,
        authorizationError: socket.authorizationError === null || socket.authorizationError === undefined
          ? null
          : String(socket.authorizationError),
      })
    })
    socket.once('timeout', () => done({ error: 'timed out' }))
    socket.once('error', (error) => done({ error: `${error.code ?? 'error'} ${error.message}`.trim() }))
  })
}

// --------------------------------------------------------------------- snippet
if (command === 'snippet') {
  log(buildSnippet({ location, relayPort, healthPath }))
  process.exit(0)
}

// ----------------------------------------------------------------------- chain
if (command === 'chain') {
  const host = typeof args.host === 'string' ? args.host : domain
  if (host === '') {
    process.stderr.write('deploy-relay chain: --domain <name> (or --host <ip>) is required\n')
    process.exit(2)
  }
  const port = Number(args.port ?? 443)
  const servername = typeof args.servername === 'string' ? args.servername : host
  const found = await inspectChain(host, port, servername)
  if (found.error !== undefined) {
    log(`chain         cannot connect to ${host}:${port} (${found.error})`)
    process.exit(1)
  }
  log(`endpoint      ${host}:${port} (SNI ${servername})`)
  log(`certificates  ${found.sent} sent by the server: ${found.names.join(' -> ')}`)
  log(`subject       ${JSON.stringify(found.subject)}`)
  log(`issued by     ${JSON.stringify(found.issuer)}`)
  log(`valid until   ${found.validTo}`)
  log(`alt names     ${found.altnames}`)
  log(`node trust    ${found.authorized ? 'OK' : `REFUSED (${found.authorizationError})`}`)
  if (found.sent < 2) {
    log('')
    for (const line of ['that is only the leaf certificate, so a strict client cannot build a chain:']) log(line)
    for (const line of chainHint('unable to verify')) log(line)
    process.exit(1)
  }
  if (!found.authorized) {
    log('')
    for (const line of chainHint(String(found.authorizationError))) log(line)
    process.exit(1)
  }
  process.exit(0)
}

// ----------------------------------------------------------------------- status
if (command === 'stop') {
  process.exit(stopRelay() ? 0 : 1)
}

if (command === 'status') {
  const nginx = locateNginx()
  const text = readFileSync(nginx.conf, 'utf8')
  const managed = hasManagedBlock(text)
  const block = domain === '' ? undefined : findServerBlock(text, domain)
  log(`nginx         ${nginx.exe}`)
  log(`config        ${nginx.conf}`)
  if (domain === '') {
    log('vhost         (no --domain given, so the vhost and the public URL were not checked)')
  } else {
    log(`vhost for ${domain}: ${block === undefined ? 'NOT FOUND' : `line ${block.line}${block.tls ? ' (TLS)' : ' (no ssl_certificate!)'}`}`)
  }
  log(`managed block: ${managed ? 'present' : 'absent'}`)
  const relayUp = await isListening(relayPort)
  log(`relay port ${relayPort}: ${relayUp ? 'listening' : 'not listening'}`)
  if (domain === '') process.exit(managed && relayUp ? 0 : 1)
  const url = publicUrl(domain, location, healthPath)
  const result = await probe(url, args.insecure === true)
  log(`public probe  ${url} -> ${result.ok ? 'OK' : `FAILED (${result.detail})`}`)
  process.exit(result.ok && managed ? 0 : 1)
}

const nginx = locateNginx()
const original = readFileSync(nginx.conf, 'utf8')

// --------------------------------------------------------------------- rollback
if (command === 'rollback') {
  const removed = removeManagedBlock(original)
  if (!removed.changed) {
    log(`nothing to roll back (${removed.reason})`)
    process.exit(0)
  }
  const backup = `${nginx.conf}.bak-${Date.now()}`
  copyFileSync(nginx.conf, backup)
  writeFileSync(nginx.conf, removed.text, 'utf8')
  const test = nginxTest(nginx)
  if (!test.ok) {
    copyFileSync(backup, nginx.conf)
    log('nginx -t FAILED after rollback; the previous config has been restored')
    log(test.output)
    process.exit(1)
  }
  const reload = nginxReload(nginx)
  log(`removed the managed block; nginx -t passed; reload ${reload.ok ? 'ok' : `FAILED: ${reload.output}`}`)
  process.exit(reload.ok ? 0 : 1)
}

if (command !== 'plan' && command !== 'apply') {
  process.stderr.write(`deploy-relay: unknown command ${JSON.stringify(command)} (plan|apply|chain|status|rollback|stop|snippet)\n`)
  process.exit(2)
}

// ------------------------------------------------------------------ plan/apply
const block = findServerBlock(original, domain)
log(`nginx exe     ${nginx.exe}`)
log(`nginx prefix  ${nginx.prefix}`)
log(`config file   ${nginx.conf}`)

if (block === undefined) {
  process.stderr.write(
    `\nNo \`server\` block in ${nginx.conf} serves ${domain}.\n`
    + 'Point --conf at the file that does (nginx may split vhosts across includes),\n'
    + 'or use `snippet` and paste the block yourself following docs/nginx-relay.conf.\n',
  )
  process.exit(1)
}
log(`target vhost  server_name ${block.names.join(' ')} at line ${block.line}${block.tls ? ' (TLS)' : ''}`)
if (!block.tls) {
  process.stderr.write('\nThat vhost has no ssl_certificate, so it cannot carry a wss:// endpoint. Add the certificate first.\n')
  process.exit(1)
}
if (hasManagedBlock(original)) {
  log('\nthe managed block is already present; nothing to insert')
  const url = publicUrl(domain, location, healthPath)
  if (command === 'apply') {
    await startRelay()
    const result = await probeEventually(url, args.insecure === true)
    log(`public probe  ${url} -> ${result.ok ? `OK (attempt ${result.attempts})` : `FAILED (${result.detail})`}`)
    process.exit(result.ok ? 0 : 3)
  }
  process.exit(0)
}
if (hasForeignLocation(original, location)) {
  process.stderr.write(`\n${location} is already claimed by an unmanaged location block. Refusing to collide with it.\n`)
  process.exit(1)
}

const snippet = buildSnippet({ location, relayPort, healthPath })
const edited = insertManagedBlock(original, domain, snippet)
if (!edited.changed) {
  process.stderr.write(`\ncannot edit: ${edited.reason}\n`)
  process.exit(1)
}

const addedLines = edited.text.split('\n').length - original.split('\n').length
log(`\nwould insert ${addedLines} lines into the vhost at line ${block.line}:`)
log('----8<----')
log(snippet.split('\n').map((line) => `    ${line}`).join('\n'))
log('---->8----')

if (command === 'plan') {
  log('\nplan only: nothing was written. Re-run with `apply` to do it.')
  log('apply will: back up the config, insert the block, run `nginx -t`,')
  log('            restore the backup if the test fails, then reload, start the')
  log('            relay, and probe the public health URL.')
  process.exit(0)
}

// ------------------------------------------------------------------------ apply
const backup = `${nginx.conf}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(nginx.conf, backup)
log(`\nbackup        ${backup}`)
writeFileSync(nginx.conf, edited.text, 'utf8')
log('inserted the managed block')

const test = nginxTest(nginx)
if (!test.ok) {
  copyFileSync(backup, nginx.conf)
  log('nginx -t FAILED, so the config was restored from the backup immediately:')
  log(test.output)
  const retest = nginxTest(nginx)
  log(`after restore, nginx -t is ${retest.ok ? 'clean again' : 'STILL FAILING — restore manually from the backup above'}`)
  process.exit(2)
}
log('nginx -t passed')

const reload = nginxReload(nginx)
if (!reload.ok) {
  log(`nginx -s reload FAILED: ${reload.output}`)
  log('the config is valid, so it will take effect on the next restart; the relay was NOT started')
  process.exit(2)
}
log('nginx reloaded')

await startRelay()
const url = publicUrl(domain, location, healthPath)
const result = await probeEventually(url, args.insecure === true)
log(`public probe  ${url} -> ${result.ok ? `OK (attempt ${result.attempts})` : `FAILED (${result.detail})`}`)
if (!result.ok) {
  log('')
  log('The relay is running and nginx accepted the config, but the public URL did not answer.')
  log('Check, in order: the DNS A record points at this machine; the firewall allows 443;')
  log('Certify The Web issued a certificate covering this name; nothing else shadows the path.')
  for (const line of chainHint(result.detail)) log(line)
  log(`To undo the nginx change: node tools/deploy-relay.mjs rollback --domain ${domain}`)
  process.exit(3)
}
log('')
log(`relay ready: wss://${domain}${publicPort}${location}`)
log('Put that URL and this secret into the plugin settings on every machine:')
log(`  ${existsSync(path.join(relayDir, 'relay-secret.txt')) ? relaySecret() : '(see relay-secret.txt)'}`)
process.exit(0)
