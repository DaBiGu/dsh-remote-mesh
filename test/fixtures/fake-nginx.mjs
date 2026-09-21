/**
 * A stand-in for `nginx` used by the deployment test.
 *
 * It answers `-V` the way a real nginx does (so the deploy script can discover
 * the conf path), and it makes `-t` a **real** check: it fails when the config's
 * braces are unbalanced. That is the failure mode the deploy script's backup and
 * restore exist for, so the test can prove the restore actually happens.
 *
 * Create a file named FORCE_FAIL next to this script to make `-t` fail
 * unconditionally, which simulates a config nginx rejects for any other reason.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const conf = path.join(here, 'conf', 'nginx.conf')
const argv = process.argv.slice(2)

/**
 * Count block delimiters the way nginx does: a brace inside a comment or a
 * quoted string is text, not structure. The masking helper is shared with the
 * editor under test, so this stand-in models the real parser rather than a
 * naive one that the fixture would trip over on purpose.
 * @param {string} text - Configuration text.
 * @returns {{open: number, close: number}} the delimiter counts.
 */
async function countBraces(text) {
  const tools = process.env.DSH_MESH_TOOLS
  if (tools !== undefined) {
    const module = await import(pathToFileURL(path.join(tools, 'nginx-edit.mjs')).href)
    const masked = module.maskNonStructural(text)
    return { open: (masked.match(/\{/g) || []).length, close: (masked.match(/\}/g) || []).length }
  }
  return { open: (text.match(/\{/g) || []).length, close: (text.match(/\}/g) || []).length }
}

if (argv.includes('-V')) {
  process.stderr.write('nginx version: nginx/1.24.0 (dsh-remote-workspaces test stand-in)\n')
  process.stderr.write(`built by fake\nconfigure arguments: --conf-path=conf/nginx.conf --prefix=${here}\n`)
  process.exit(0)
}

if (argv.includes('-t')) {
  const forced = path.join(here, 'FORCE_FAIL')
  if (existsSync(forced)) {
    // One shot: this models "the edit produced a config nginx rejects and the
    // restore fixes it", which is exactly the sequence the backup/restore path
    // exists for. A permanent failure would only prove the operator has to
    // intervene, which the script also reports.
    rmSync(forced, { force: true })
    process.stderr.write('nginx: [emerg] forced failure for the test\n')
    process.stderr.write('nginx: configuration file test failed\n')
    process.exit(1)
  }
  const counts = await countBraces(readFileSync(conf, 'utf8'))
  if (counts.open !== counts.close) {
    process.stderr.write(`nginx: [emerg] unexpected end of file, expecting "}" (braces ${counts.open} vs ${counts.close})\n`)
    process.stderr.write('nginx: configuration file test failed\n')
    process.exit(1)
  }
  process.stdout.write('nginx: the configuration file syntax is ok\n')
  process.stdout.write('nginx: configuration file test is successful\n')
  process.exit(0)
}

if (argv.includes('-s')) {
  process.stdout.write('signal process started\n')
  process.exit(0)
}

process.exit(0)
