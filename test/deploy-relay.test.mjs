/**
 * Integration checks for the relay deployment's safety net.
 *
 * A stand-in nginx (`test/fixtures/nginx.cmd`) lets this run anywhere: the
 * deploy script talks to it exactly as it would talk to the real thing, so the
 * properties that matter are actually exercised rather than asserted by reading
 * the code --? *
 *   - `plan` changes nothing,
 *   - `apply` inserts the block, passes `nginx -t`, and only then reloads,
 *   - a config nginx rejects is restored from the backup automatically,
 *   - a health probe that races the reload is retried instead of reported as a
 *     failure,
 *   - `rollback` restores the file byte-for-byte,
 *   - `stop` releases the relay port.
 *
 * Every fixture lives in a temp directory, so nothing in the repository or in a
 * real nginx install is touched.
 * Run with `node test/deploy-relay.test.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEPLOY = path.join(ROOT, 'tools', 'deploy-relay.mjs')

/**
 * Pick a free port for this run.
 *
 * A fixed port would make the test depend on whatever else is on the machine,
 * and on any relay an earlier run left behind: `startRelay` treats an occupied
 * port as "already running" and writes no pid, so `stop` would have nothing to
 * signal.
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

const RELAY_PORT = await freePort()

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

/**
 * Build a throwaway nginx install: the stand-in executable at the root (so the
 * script's prefix detection sees it) plus `conf/nginx.conf`.
 * @returns {{dir: string, conf: string, nginx: string}} the fixture paths.
 */
function makeInstall() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-mesh-nginx-'))
  mkdirSync(path.join(dir, 'conf'), { recursive: true })
  copyFileSync(path.join(HERE, 'fixtures', 'fake-nginx.mjs'), path.join(dir, 'fake-nginx.mjs'))
  // The wrapper must live beside the fake module: it resolves its sibling
  // through %~dp0, and the deploy script derives the nginx prefix from the
  // wrapper's own directory.
  copyFileSync(path.join(HERE, 'fixtures', 'nginx.cmd'), path.join(dir, 'nginx.cmd'))
  cpSync(path.join(HERE, 'fixtures', 'nginx'), dir, { recursive: true })
  return { dir, conf: path.join(dir, 'conf', 'nginx.conf'), nginx: path.join(dir, 'nginx.cmd') }
}

/**
 * An https health endpoint that fails its first requests and then answers the
 * way a live relay does.
 *
 * This is the shape of the real race: the probe fires the instant `nginx -s
 * reload` returns, and the worker still serving the previous config can answer
 * a request or two before the new one takes over. The certificate is the
 * throwaway localhost pair in `test/fixtures` — it protects nothing (see that
 * directory's README).
 * @param {number} failures - How many requests to answer with 404 first.
 * @returns {Promise<{port: number, served: {requests: number}, close: () => Promise<void>}>} the endpoint.
 */
async function flakyHealth(failures) {
  const served = { requests: 0 }
  const server = https.createServer(
    {
      cert: readFileSync(path.join(HERE, 'fixtures', 'localhost-test-cert.pem')),
      key: readFileSync(path.join(HERE, 'fixtures', 'localhost-test-key.pem')),
    },
    (_request, response) => {
      served.requests += 1
      if (served.requests <= failures) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('nothing here yet\n')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true,"service":"dsh-remote-mesh-relay"}')
    },
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    served,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  }
}

/**
 * @param {string[]} argv - Arguments for the deploy script.
 * @returns {{status: number, output: string}} the run result.
 */
function deploy(argv) {
  const result = spawnSync(process.execPath, [DEPLOY, ...argv], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * Run the deploy script without freezing this process.
 *
 * `deploy()` uses `spawnSync`, which blocks the event loop for the entire child
 * run — including any listener this process is hosting. A check that needs the
 * child to reach a server we started here has to use this form instead.
 * @param {string[]} argv - Arguments for the deploy script.
 * @returns {Promise<{status: number|null, output: string}>} the run result.
 */
function deployAsync(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DEPLOY, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('close', (status) => resolve({ status, output }))
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
    setTimeout(() => done(false), 1500).unref()
  })
}

const install = makeInstall()
const relayDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-mesh-relaydir-'))
const original = readFileSync(install.conf, 'utf8')
const base = ['--domain', 'localhost', '--relay-port', String(RELAY_PORT), '--relay-dir', relayDir, '--nginx', install.nginx]
// The stand-in nginx borrows the editor's parser so it can tell a structural
// brace from one inside a comment; tell it where the tools live.
process.env.DSH_MESH_TOOLS = path.join(ROOT, 'tools')

try {
  const plan = deploy(['plan', ...base])
  await check('plan reports the edit and writes nothing', () => {
    assert.equal(plan.status, 0, plan.output)
    assert.match(plan.output, /would insert \d+ lines/)
    assert.match(plan.output, /plan only: nothing was written/)
    assert.equal(readFileSync(install.conf, 'utf8'), original)
  })

  const applied = deploy(['apply', ...base])
  await check('apply inserts the block, passes nginx -t and reloads', () => {
    // The public probe cannot succeed here (there is no https://localhost), so a
    // non-zero exit is expected --?but it must be the probe's code, not a
    // config failure, and the config must have been accepted.
    assert.match(applied.output, /nginx -t passed/)
    assert.match(applied.output, /nginx reloaded/)
    assert.match(applied.output, /relay started|already listening/)
    assert.equal(applied.status, 3, applied.output)
    const text = readFileSync(install.conf, 'utf8')
    assert.match(text, />>> dsh-remote-mesh/)
    assert.match(text, /location \/__dsh-mesh\/relay/)
    assert.match(text, new RegExp(`proxy_pass\\s+http://127\\.0\\.0\\.1:${RELAY_PORT}/`))
  })

  await check('the edit went into the TLS vhost and not the redirect', () => {
    const text = readFileSync(install.conf, 'utf8')
    const redirect = text.slice(text.indexOf('listen       80;'), text.indexOf('listen       443 ssl;'))
    assert.equal(redirect.includes('__dsh-mesh'), false, 'the port-80 redirect must be untouched')
    const unrelated = text.slice(text.indexOf('shop.example.com'))
    assert.equal(unrelated.includes('__dsh-mesh'), false, 'the unrelated vhost must be untouched')
  })

  await check('the relay is running on the requested port', async () => {
    assert.equal(await listening(RELAY_PORT), true)
  })

  const second = deploy(['apply', ...base])
  await check('a second apply is a no-op, not a duplicate block', () => {
    // One managed block, holding the relay location and its health probe.
    assert.equal((readFileSync(install.conf, 'utf8').match(/# >>> dsh-remote-mesh/g) || []).length, 1)
    assert.equal(second.status, 3, second.output)
  })

  const stopped = deploy(['stop', '--relay-dir', relayDir])
  await check('stop releases the relay port', async () => {
    assert.equal(stopped.status, 0, stopped.output)
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(await listening(RELAY_PORT), false)
  })

  const rolled = deploy(['rollback', ...base])
  await check('rollback restores the config byte-for-byte', () => {
    assert.equal(rolled.status, 0, rolled.output)
    assert.equal(readFileSync(install.conf, 'utf8'), original)
  })

  // ------------------------------------------------------------------ the race
  // Found against a real nginx: `apply` probed once, the request landed on the
  // worker that was still serving the old config, and a perfectly healthy
  // deployment was reported as "the public URL did not answer" (exit 3).
  const flaky = await flakyHealth(2)
  try {
    const retried = await deployAsync(['apply', ...base, '--public-port', String(flaky.port), '--insecure'])
    await check('a probe that races the reload is retried, not reported as a failure', () => {
      assert.equal(retried.status, 0, retried.output)
      assert.match(retried.output, /public probe\s+\S+ -> OK \(attempt 3\)/)
      assert.equal(flaky.served.requests, 3, 'two 404s then the real answer')
    })
  } finally {
    await flaky.close()
    // Put the config back: the checks below start from a clean vhost.
    deploy(['rollback', ...base])
  }

  // ------------------------------------------------------------------ tls chain
  // The real-world case this command was written for: a server that sends only
  // its leaf certificate. Browsers reach it anyway (they fetch the missing
  // intermediate over AIA), Node refuses — and the plugin's client is Node.
  const leafOnly = await flakyHealth(0)
  try {
    const chain = await deployAsync(['chain', '--host', '127.0.0.1', '--port', String(leafOnly.port), '--servername', 'localhost'])
    await check('chain reports a leaf-only, untrusted endpoint instead of a clean bill', () => {
      assert.equal(chain.status, 1, chain.output)
      assert.match(chain.output, /certificates {2}1 sent by the server/)
      assert.match(chain.output, /node trust {4}REFUSED/)
      assert.match(chain.output, /only the leaf certificate/)
    })
  } finally {
    await leafOnly.close()
  }

  // ---------------------------------------------------------------- failure path
  writeFileSync(path.join(install.dir, 'FORCE_FAIL'), '1', 'utf8')
  const failed = deploy(['apply', ...base])
  await check('a config nginx rejects is restored from the backup automatically', () => {
    assert.equal(failed.status, 2, failed.output)
    assert.match(failed.output, /nginx -t FAILED, so the config was restored/)
    assert.match(failed.output, /after restore, nginx -t is clean again/)
    assert.equal(readFileSync(install.conf, 'utf8'), original, 'the file must be back to its original bytes')
    assert.equal(readFileSync(install.conf, 'utf8').includes('__dsh-mesh'), false)
  })
  rmSync(path.join(install.dir, 'FORCE_FAIL'), { force: true })

  const noDomain = deploy(['plan', '--relay-port', String(RELAY_PORT), '--nginx', install.nginx])
  await check('a missing --domain is refused with usage', () => {
    assert.equal(noDomain.status, 2)
    assert.match(noDomain.output, /--domain <name> is required/)
  })

  const wrongDomain = deploy(['plan', '--domain', 'nope.example.com', '--nginx', install.nginx])
  await check('a domain with no vhost is refused, not guessed', () => {
    assert.equal(wrongDomain.status, 1)
    assert.match(wrongDomain.output, /No `server` block in/)
  })

  const snippet = deploy(['snippet', '--relay-port', String(RELAY_PORT)])
  await check('snippet prints the block without needing nginx or a domain', () => {
    assert.equal(snippet.status, 0, snippet.output)
    assert.match(snippet.output, /location \/__dsh-mesh\/relay/)
    assert.match(snippet.output, /proxy_set_header\s+Upgrade/)
  })
} finally {
  // Never leave a stray relay process behind, even if an assertion threw.
  deploy(['stop', '--relay-dir', relayDir])
  rmSync(install.dir, { recursive: true, force: true })
  rmSync(relayDir, { recursive: true, force: true })
}

process.stdout.write(`\n${passed} checks passed\n`)
assert.equal(existsSync(path.join(ROOT, 'relay.pid')), false, 'the test must not leave a relay.pid in the plugin directory')
