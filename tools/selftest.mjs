#!/usr/bin/env node
/**
 * Run every self-check in one go.
 *
 *   node tools/selftest.mjs
 *
 * Suites run sequentially because the mesh suite binds real loopback ports.
 * Nothing here needs a second machine, a public server, or a real nginx.
 * @module dsh-remote-workspaces/tools/selftest
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SUITES = [
  ['crypto', 'Handshake, cluster authentication, AEAD framing', 'test/crypto.test.mjs'],
  ['mesh', 'Live sockets, tunnels, concurrency, relay, SSRF guard, crash guard', 'test/mesh.test.mjs'],
  ['tls', 'wss:// behind a TLS terminator: trust, refusal, relay restart recovery', 'test/relay-tls.test.mjs'],
  ['nginx', 'Config surgery: block selection, insertion, byte-exact rollback', 'test/nginx-edit.test.mjs'],
  ['deploy', 'Relay deployment: plan, apply, backup, auto-restore, rollback, stop', 'test/deploy-relay.test.mjs'],
]

let failed = 0
let skipped = 0
let total = 0
const results = []

for (const [name, description, file] of SUITES) {
  process.stdout.write(`\n=== ${name}: ${description}\n`)
  const result = spawnSync(process.execPath, [path.join(ROOT, file)], { encoding: 'utf8', cwd: ROOT })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const checks = Number(/^(\d+) checks passed/m.exec(output)?.[1] ?? 0)
  // 77 is the conventional "skipped" code a suite uses when its tooling is absent.
  const wasSkipped = result.status === 77
  const ok = result.status === 0
  if (wasSkipped) skipped += 1
  else if (!ok) failed += 1
  total += checks
  // Surface the suite's own lines, so a failure is readable in one place.
  process.stdout.write(output.trimEnd() + '\n')
  results.push({ name, ok, skipped: wasSkipped, checks, status: result.status })
}

process.stdout.write('\n=== summary\n')
for (const entry of results) {
  const verdict = entry.skipped ? 'SKIP' : entry.ok ? 'PASS' : 'FAIL'
  process.stdout.write(`  ${verdict}  ${entry.name.padEnd(8)} ${String(entry.checks).padStart(2)} checks${entry.ok || entry.skipped ? '' : ` (exit ${entry.status})`}\n`)
}
process.stdout.write(
  `  ${failed === 0 ? 'all suites passed' : `${failed} suite(s) failed`}`
  + `${skipped === 0 ? '' : `, ${skipped} skipped`}, ${total} checks total\n`,
)

if (failed !== 0) {
  process.stdout.write('\nA failure here is a real defect. The tls and deploy suites need no server:\n')
  process.stdout.write('they use a local TLS terminator and test/fixtures/nginx.cmd respectively.\n')
}
process.exit(failed === 0 ? 0 : 1)
