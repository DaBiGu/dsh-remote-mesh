#!/usr/bin/env node
/**
 * Dump one Harness session log as text.
 *
 * Session logs are append-only, one zstd frame per flush, so a single
 * `zstdDecompressSync` only recovers the first frame. The streaming
 * decompressor consumes every concatenated frame.
 *
 * Usage: node tools/read-session.mjs <session-id-or-path> [--grep <text>]
 * @module dsh-remote-mesh/tools/read-session
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { zstdDecompressSync } from 'node:zlib'

/**
 * @param {string} dir - Directory to walk.
 * @returns {string[]} every file below it.
 */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  )
}

/**
 * Decompress every concatenated zstd frame in a log.
 *
 * Node's streaming decompressor stops at the first frame, and a session log is
 * one frame per flush, so the frames are split on the zstd magic and each is
 * decompressed on its own.
 * @param {string} file - Zstd-compressed log.
 * @returns {Buffer} the fully decompressed log.
 */
function decompressAll(file) {
  const raw = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let at = raw.indexOf(magic); at !== -1; at = raw.indexOf(magic, at + 1)) starts.push(at)
  if (starts.length <= 1) return zstdDecompressSync(raw)
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const slice = raw.subarray(starts[index], starts[index + 1] ?? raw.length)
    try {
      parts.push(zstdDecompressSync(slice))
    } catch {
      // A trailing partial frame is a torn tail, which the Harness itself
      // truncates on the next write; skipping it is the right read behavior.
    }
  }
  return Buffer.concat(parts)
}

const [needle, ...rest] = process.argv.slice(2)
if (needle === undefined) {
  process.stderr.write('read-session: pass a session id or a path\n')
  process.exit(2)
}
const grepIndex = rest.indexOf('--grep')
const grep = grepIndex === -1 ? undefined : rest[grepIndex + 1]

const resolved = statSync(needle, { throwIfNoEntry: false })?.isFile()
  ? needle
  : walk(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'))
      .concat(walk(process.env.TWIN_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')))
      .find((file) => file.includes(needle) && file.endsWith('.zstd'))
if (resolved === undefined) {
  process.stderr.write(`read-session: no log matching ${JSON.stringify(needle)}\n`)
  process.exit(1)
}

const text = (await decompressAll(resolved)).toString('utf8')
process.stdout.write(`# ${resolved}\n# ${text.length} bytes decompressed\n`)
const records = text.split('\n').filter((line) => line.trim() !== '')
process.stdout.write(`# ${records.length} records\n`)
for (const line of records) {
  if (grep !== undefined && !line.includes(grep)) continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    process.stdout.write(`?? ${line.slice(0, 200)}\n`)
    continue
  }
  const kind = record.kind ?? record.type ?? '?'
  if (grep === undefined && !/message|text|title/i.test(JSON.stringify(record).slice(0, 200))) continue
  process.stdout.write(`-- ${kind}: ${JSON.stringify(record).slice(0, 600)}\n`)
}
