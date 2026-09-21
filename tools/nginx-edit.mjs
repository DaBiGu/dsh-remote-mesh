/**
 * Pure nginx configuration surgery for the relay deployment.
 *
 * The relay needs one `location` block inside an existing `server` block that
 * already has a certificate. Hand-editing a production nginx.conf is the
 * riskiest step in the whole setup — a stray brace takes every other site on
 * that machine down — so the edit is done by these functions and every one of
 * them is unit-tested against real-world config shapes.
 *
 * Nothing here runs nginx or touches the filesystem: `deploy-relay.mjs` owns
 * the orchestration (backup, `nginx -t`, reload, revert) and this module owns
 * only "what should the text become".
 * @module dsh-remote-workspaces/tools/nginx-edit
 */

/** Opening marker of the managed region. */
export const MARKER_OPEN = '# >>> dsh-remote-workspaces (managed block, safe to delete) >>>'
/** Closing marker of the managed region. */
export const MARKER_CLOSE = '# <<< dsh-remote-workspaces (managed block, safe to delete) <<<'

/**
 * Blank out comments and quoted strings so brace counting cannot be confused by
 * a `#` inside a path or a `}` inside a regex. The result has the same length
 * and the same newlines as the input, so offsets stay valid.
 * @param {string} text - nginx configuration text.
 * @returns {string} the structurally-significant characters with the rest blanked.
 */
export function maskNonStructural(text) {
  const out = text.split('')
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') {
        out[index] = ' '
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      out[index] = ' '
      index += 1
      while (index < text.length && text[index] !== quote) {
        if (text[index] !== '\n') out[index] = ' '
        index += 1
      }
      if (index < text.length) {
        out[index] = ' '
        index += 1
      }
      continue
    }
    index += 1
  }
  return out.join('')
}

/**
 * Depth of nesting *before* each character, counting `{` and `}` in the masked text.
 * @param {string} masked - Masked configuration text.
 * @returns {Int32Array} one depth per character.
 */
export function depths(masked) {
  const result = new Int32Array(masked.length)
  let depth = 0
  for (let index = 0; index < masked.length; index += 1) {
    result[index] = depth
    const char = masked[index]
    if (char === '{') depth += 1
    else if (char === '}') depth = Math.max(0, depth - 1)
  }
  return result
}

/**
 * @param {string} masked - Masked text.
 * @param {number} openIndex - Index of the `{` that opens a block.
 * @returns {number} the index of the matching `}`, or -1.
 */
export function matchBrace(masked, openIndex) {
  let depth = 0
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * @param {string} text - Configuration text.
 * @returns {{start: number, openBrace: number, end: number}[]} every `server` block.
 */
export function serverBlocks(text) {
  const masked = maskNonStructural(text)
  const level = depths(masked)
  const blocks = []
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '{') continue
    // A `server` block is one that opens at http level (depth 1) and is named.
    if (level[index] !== 1) continue
    const before = text.slice(Math.max(0, index - 40), index)
    if (!/(^|[\s;{}])server\s*$/.test(before.replace(/\s+$/, '') + ' ')) continue
    const end = matchBrace(masked, index)
    if (end === -1) continue
    blocks.push({ start: index, openBrace: index, end })
  }
  return blocks
}

/**
 * Split a `server_name` directive value into its individual names.
 * @param {string} value - Everything between `server_name` and `;`.
 * @returns {string[]} the names, lowercased.
 */
function nameTokens(value) {
  return value
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
}

/**
 * Find every `server` block that serves a domain.
 * @param {string} text - Configuration text.
 * @param {string} domain - Domain to look for, for example `shop.example.com`.
 * @returns {{start: number, end: number, names: string[], line: number, tls: boolean}[]} matching blocks, in file order.
 */
export function findServerBlocks(text, domain) {
  const wanted = domain.trim().toLowerCase()
  const found = []
  for (const block of serverBlocks(text)) {
    const body = text.slice(block.openBrace, block.end)
    const match = /(^|\n)[ \t]*server_name[ \t]+([^;]*);/.exec(body)
    if (match === null) continue
    const names = nameTokens(match[2])
    if (!names.includes(wanted) && !names.includes(`*.${wanted.split('.').slice(1).join('.')}`)) continue
    const nameOffset = block.openBrace + match.index
    found.push({
      start: block.start,
      end: block.end,
      names,
      line: text.slice(0, nameOffset).split('\n').length,
      tls: /ssl_certificate|listen[^;]*\bssl\b/.test(body),
    })
  }
  return found
}

/**
 * Find the block a relay location should go into.
 *
 * A domain usually has two blocks — the port-80 redirect and the TLS one — and
 * only the TLS block can carry a `wss://` endpoint, so a TLS block always wins.
 * @param {string} text - Configuration text.
 * @param {string} domain - Domain to look for.
 * @returns {{start: number, end: number, names: string[], line: number, tls: boolean}|undefined} the chosen block.
 */
export function findServerBlock(text, domain) {
  const candidates = findServerBlocks(text, domain)
  if (candidates.length === 0) return undefined
  return candidates.find((candidate) => candidate.tls) ?? candidates[0]
}

/**
 * @param {string} text - Configuration text.
 * @returns {boolean} whether the managed region is present.
 */
export function hasManagedBlock(text) {
  return text.includes(MARKER_OPEN)
}

/**
 * Build the managed region for one location.
 *
 * Everything the block adds lives under the relay's own path prefix — the
 * health probe included. An earlier version used a bare `location = /healthz`,
 * which quietly changed how `/healthz` was served on whatever vhost it was
 * inserted into; a plugin that fronts a relay has no business editing an
 * unrelated site's URL space.
 * @param {{location: string, relayPort: number, healthPath?: string}} options - Location, loopback relay port.
 * @returns {string} the snippet, without a trailing newline.
 */
export function buildSnippet({ location, relayPort, healthPath = '/healthz' }) {
  const origin = `http://127.0.0.1:${relayPort}`
  return [
    MARKER_OPEN,
    `location ${location} {`,
    '    # The trailing slash makes nginx strip the prefix, so the relay sees "/".',
    `    proxy_pass         ${origin}/;`,
    '',
    '    proxy_http_version  1.1;',
    '    # These two lines are what turn the request into a WebSocket. If your',
    '    # http block already defines $connection_upgrade, use that variable here',
    '    # instead of the literal "upgrade".',
    '    proxy_set_header    Upgrade $http_upgrade;',
    '    proxy_set_header    Connection "upgrade";',
    '    proxy_set_header    Host $host;',
    '    proxy_set_header    X-Real-IP $remote_addr;',
    '',
    '    # A mesh link is idle most of the time; the client pings every 25s, so the',
    '    # read timeout has to stay far above that.',
    '    proxy_read_timeout  3600s;',
    '    proxy_send_timeout  3600s;',
    '',
    '    # Streaming in both directions, so nginx must not collect the response.',
    '    proxy_buffering     off;',
    '    proxy_request_buffering off;',
    '',
    '    # binary framing of our own; gzip would only burn CPU.',
    '    gzip                off;',
    '}',
    '',
    `location = ${location}${healthPath} {`,
    `    proxy_pass ${origin}${healthPath};`,
    '    proxy_set_header Host $host;',
    '}',
    MARKER_CLOSE,
  ].join('\n')
}

/**
 * Insert the managed region into the block that serves `domain`.
 * @param {string} text - Configuration text.
 * @param {string} domain - Domain whose server block should carry the relay.
 * @param {string} snippet - Region text from {@link buildSnippet}.
 * @returns {{text: string, changed: boolean, reason?: string}} the new text.
 */
export function insertManagedBlock(text, domain, snippet) {
  if (hasManagedBlock(text)) return { text, changed: false, reason: 'the managed block is already present' }
  const block = findServerBlock(text, domain)
  if (block === undefined) {
    return { text, changed: false, reason: `no server block serves ${domain} in this file` }
  }
  // Indent the snippet to the level of the block's own closing brace.
  const lineStart = text.lastIndexOf('\n', block.end) + 1
  const closingIndent = /^[ \t]*/.exec(text.slice(lineStart, block.end))[0]
  const indented = snippet
    .split('\n')
    .map((line) => (line === '' ? '' : `${closingIndent}    ${line}`))
    .join('\n')
  // Inserted text is exactly `indented` plus its own newline, so removal can
  // restore the file byte-for-byte and a rollback is provably lossless.
  const head = text.slice(0, lineStart)
  const tail = text.slice(lineStart)
  return { text: `${head}${indented}\n${tail}`, changed: true }
}

/**
 * Remove the managed region, leaving the rest of the file byte-identical.
 * @param {string} text - Configuration text.
 * @returns {{text: string, changed: boolean, reason?: string}} the new text.
 */
export function removeManagedBlock(text) {
  const start = text.indexOf(MARKER_OPEN)
  if (start === -1) return { text, changed: false, reason: 'no managed block to remove' }
  const endMarker = text.indexOf(MARKER_CLOSE)
  if (endMarker === -1) {
    return { text, changed: false, reason: 'the managed block has an opening marker but no closing marker; refusing to guess' }
  }
  let end = endMarker + MARKER_CLOSE.length
  // Swallow the marker's own line and the blank line the insert added.
  const afterMarker = text.indexOf('\n', end)
  if (afterMarker !== -1) end = afterMarker + 1
  // Also drop the indentation that preceded the opening marker.
  let lineStart = text.lastIndexOf('\n', start - 1) + 1
  const prefix = text.slice(lineStart, start)
  if (/^[ \t]*$/.test(prefix)) {
    const beforeLine = lineStart
    return { text: text.slice(0, beforeLine) + text.slice(end), changed: true }
  }
  return { text: text.slice(0, start) + text.slice(end), changed: true }
}

/**
 * @param {string} text - Configuration text.
 * @param {string} location - Location path, for example `/__dsh-mesh/relay`.
 * @returns {boolean} whether an *unmanaged* location already claims the path.
 */
export function hasForeignLocation(text, location) {
  const masked = maskNonStructural(text)
  const pattern = new RegExp(`location\\s+(=\\s*)?${location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|\\{)`)
  return pattern.test(masked)
}
