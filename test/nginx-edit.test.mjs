/**
 * Unit checks for the nginx config surgery.
 *
 * This is the one part of the deployment that cannot be exercised against a
 * real nginx from here, so it is tested hard against the config shapes a real
 * machine has: nested blocks, comments containing braces, quoted regexes,
 * multiple server blocks, CRLF line endings, and configs that must be refused.
 * Run with `node test/nginx-edit.test.mjs`.
 */
import assert from 'node:assert/strict'
import {
  buildSnippet,
  findServerBlock,
  hasForeignLocation,
  hasManagedBlock,
  insertManagedBlock,
  maskNonStructural,
  removeManagedBlock,
} from '../tools/nginx-edit.mjs'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

const SNIPPET = buildSnippet({ location: '/__dsh-mesh/relay', relayPort: 8787 })

const REAL_WORLD = `worker_processes  1;

events { worker_connections 1024; }

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;

    server {
        listen       80;
        server_name  shop.example.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen       443 ssl;
        server_name  shop.example.com;

        ssl_certificate     C:/Certify/Assets/shop.example.com-chain.pem;
        ssl_certificate_key C:/Certify/Assets/shop.example.com-key.pem;

        # a comment with a stray brace } must not confuse the parser
        location / {
            proxy_pass http://127.0.0.1:8080;
            proxy_set_header X-Pattern "^/a{1,3}$";
        }
    }

    server {
        listen       443 ssl;
        server_name  other.example.com;
        ssl_certificate     C:/Certify/Assets/other-chain.pem;
        ssl_certificate_key C:/Certify/Assets/other-key.pem;
        location / { proxy_pass http://127.0.0.1:9090; }
    }
}
`

check('the masker blanks comments and quoted strings but keeps newlines', () => {
  const masked = maskNonStructural(REAL_WORLD)
  assert.equal(masked.length, REAL_WORLD.length)
  assert.equal((masked.match(/\n/g) || []).length, (REAL_WORLD.match(/\n/g) || []).length)
  assert.equal(masked.includes('stray brace'), false)
  assert.equal(masked.includes('/a{1,3}'), false)
  assert.equal(masked.includes('} must not'), false)
})

check('the right server block is found, and only by exact name', () => {
  const found = findServerBlock(REAL_WORLD, 'other.example.com')
  assert.ok(found !== undefined)
  assert.equal(found.names.includes('other.example.com'), true)
  const body = REAL_WORLD.slice(found.start, found.end)
  assert.equal(body.includes('9090'), true)
  assert.equal(body.includes('8080'), false)
  assert.equal(findServerBlock(REAL_WORLD, 'example.com'), undefined, 'a suffix must not match')
  assert.equal(findServerBlock(REAL_WORLD, 'nope.example.com'), undefined)
})

check('the https block is chosen, not the port-80 redirect', () => {
  const found = findServerBlock(REAL_WORLD, 'shop.example.com')
  assert.ok(found !== undefined)
  const body = REAL_WORLD.slice(found.start, found.end)
  assert.equal(body.includes('ssl_certificate'), true)
  assert.equal(body.includes('return 301'), false)
})

check('insertion lands inside the block and keeps the braces balanced', () => {
  const result = insertManagedBlock(REAL_WORLD, 'shop.example.com', SNIPPET)
  assert.equal(result.changed, true)
  const next = result.text
  // Count braces structurally: a brace inside a comment or a quoted regex is
  // not a block delimiter.
  const maskedBefore = maskNonStructural(REAL_WORLD)
  const maskedAfter = maskNonStructural(next)
  assert.equal(
    (maskedAfter.match(/\{/g) || []).length,
    (maskedBefore.match(/\{/g) || []).length + 2,
    'exactly the two location blocks should be added',
  )
  assert.equal(
    (maskedAfter.match(/\}/g) || []).length,
    (maskedBefore.match(/\}/g) || []).length + 2,
  )
  assert.equal(hasManagedBlock(next), true)
  const after = findServerBlock(next, 'shop.example.com')
  const body = next.slice(after.start, after.end)
  assert.equal(body.includes('/__dsh-mesh/relay'), true, 'the location must be inside the ssl server block')
  // The other vhost must be untouched.
  const other = findServerBlock(next, 'other.example.com')
  assert.equal(next.slice(other.start, other.end).includes('__dsh-mesh'), false)
})

check('insertion is idempotent', () => {
  const once = insertManagedBlock(REAL_WORLD, 'shop.example.com', SNIPPET).text
  const twice = insertManagedBlock(once, 'shop.example.com', SNIPPET)
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once)
  // Exactly one managed block, and exactly the two locations it is made of: the
  // relay prefix and its health probe, which lives under the same prefix so it
  // cannot shadow a `/healthz` the vhost already serves.
  assert.equal((twice.text.match(/# >>> dsh-remote-mesh/g) || []).length, 1)
  assert.equal((twice.text.match(/location[^\n]*__dsh-mesh\/relay/g) || []).length, 2)
})

check('removal restores the file byte-for-byte', () => {
  const changed = insertManagedBlock(REAL_WORLD, 'shop.example.com', SNIPPET).text
  const restored = removeManagedBlock(changed)
  assert.equal(restored.changed, true)
  assert.equal(restored.text, REAL_WORLD, 'a round trip must be lossless')
})

check('CRLF configs survive a round trip', () => {
  const crlf = REAL_WORLD.replace(/\n/g, '\r\n')
  const changed = insertManagedBlock(crlf, 'shop.example.com', SNIPPET)
  assert.equal(changed.changed, true)
  const restored = removeManagedBlock(changed.text)
  assert.equal(restored.text, crlf)
})

check('a config with no matching server is refused, not guessed at', () => {
  const result = insertManagedBlock(REAL_WORLD, 'mesh.example.com', SNIPPET)
  assert.equal(result.changed, false)
  assert.match(result.reason, /no server block serves/)
  assert.equal(result.text, REAL_WORLD)
})

check('an already-present location is detected before editing', () => {
  assert.equal(hasForeignLocation(REAL_WORLD, '/__dsh-mesh/relay'), false)
  assert.equal(hasForeignLocation('http { server { location /__dsh-mesh/relay { } } }', '/__dsh-mesh/relay'), true)
  assert.equal(hasForeignLocation('http { server { location = /__dsh-mesh/relay { } } }', '/__dsh-mesh/relay'), true)
})

check('a half-written managed block is refused rather than mangled', () => {
  const broken = `http {\n  server {\n    server_name a.b;\n    # >>> dsh-remote-mesh (managed block, safe to delete) >>>\n  }\n}\n`
  const result = removeManagedBlock(broken)
  assert.equal(result.changed, false)
  assert.match(result.reason, /no closing marker|opening marker but no closing/)
})

check('the snippet carries everything the relay needs', () => {
  assert.match(SNIPPET, /proxy_http_version\s+1\.1;/)
  assert.match(SNIPPET, /proxy_set_header\s+Upgrade \$http_upgrade;/)
  assert.match(SNIPPET, /proxy_buffering\s+off;/)
  assert.match(SNIPPET, /proxy_read_timeout\s+3600s;/)
  assert.match(SNIPPET, /proxy_pass\s+http:\/\/127\.0\.0\.1:8787\//)
  // The probe lives under the relay's own prefix, so inserting the block can
  // never take over a `/healthz` that the vhost was already serving.
  assert.match(SNIPPET, /location = \/__dsh-mesh\/relay\/healthz/)
  assert.doesNotMatch(SNIPPET, /location = \/healthz/)
})

process.stdout.write(`\n${passed} checks passed\n`)
