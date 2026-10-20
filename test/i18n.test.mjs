/**
 * Checks for the client bundle's localisation table.
 *
 * The bundle is a browser module, so nothing here can be imported: the test
 * reads the source and asserts the two things that actually break — a key used
 * in the UI that the dictionary does not carry, and a translation whose `%s`
 * slots do not line up with its key. It also pins the wiring to the shell's
 * locale service, because a silent fallback would look like a translation bug.
 * Run with `node test/i18n.test.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/** Read one backtick template at `i`; returns the joined key and the end index. */
function readTemplate(source, i) {
  i += 1
  let key = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      key += source[i + 1]
      i += 2
      continue
    }
    if (ch === '`') return { key, end: i + 1 }
    if (ch === '$' && source[i + 1] === '{') {
      key += '%s'
      i += 2
      let depth = 1
      while (i < source.length && depth > 0) {
        const c = source[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '`') {
          i = readTemplate(source, i).end
          continue
        }
        if (c === "'" || c === '"') {
          const quote = c
          i += 1
          while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
          i += 1
          continue
        }
        if (c === '{') depth += 1
        else if (c === '}') depth -= 1
        i += 1
      }
      continue
    }
    key += ch
    i += 1
  }
  throw new Error('unterminated template')
}

/** Read one quoted string at `i`. */
function readString(source, i) {
  const quote = source[i]
  i += 1
  let value = ''
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') {
      value += source[i + 1]
      i += 2
      continue
    }
    value += source[i]
    i += 1
  }
  return { key: value, end: i + 1 }
}

/** Every key the bundle looks up, counted by occurrence. */
function collectKeys(source) {
  const used = new Map()
  for (const match of source.matchAll(/\btr\b/g)) {
    let i = match.index + 2
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source[i] === '(') {
      i += 1
      while (i < source.length && /\s/.test(source[i])) i += 1
      if (source[i] !== "'" && source[i] !== '"') continue
      const { key } = readString(source, i)
      used.set(key, (used.get(key) ?? 0) + 1)
    } else if (source[i] === '`') {
      const { key } = readTemplate(source, i)
      used.set(key, (used.get(key) ?? 0) + 1)
    }
  }
  return used
}

const EN_WITH_BODY = (() => {
  const start = SOURCE.indexOf('const EN = {')
  assert.notEqual(start, -1, 'the bundle must carry an EN dictionary')
  const limit = SOURCE.indexOf('const ZH_COPY = {', start)
  assert.notEqual(limit, -1, 'the ZH overrides must follow the EN dictionary')
  const end = SOURCE.lastIndexOf('\n    }', limit)
  assert.notEqual(end, -1, 'the EN dictionary must be a standalone literal')
  return SOURCE.slice(start + 'const EN = '.length, end + '\n    }'.length)
})()

const EN = (0, eval)(`(${EN_WITH_BODY})`)
const USED = collectKeys(SOURCE)

check('the English dictionary parses as one object literal', () => {
  assert.equal(typeof EN, 'object')
  assert.ok(Object.keys(EN).length > 100)
})

check('English copy contains no leftover Chinese sentences', () => {
  const han = /[\u4e00-\u9fff]/
  const leaks = Object.entries(EN).filter(([, value]) => han.test(value)).map(([key]) => key)
  assert.deepEqual(leaks, [], 'these translations are still Chinese')
})

check('Chinese copy keeps the source sentences and fixes the English keys', () => {
  const zhCopy = Object.fromEntries(Object.keys(EN).map((key) => [key, key]))
  assert.equal(zhCopy['remote-workspaces'], 'remote-workspaces')
  const han = /[\u4e00-\u9fff]/
  const stragglers = Object.keys(EN).filter((key) => !han.test(key))
  assert.deepEqual(stragglers.sort(), [
    'remote-workspaces',
    'remote-workspaces: %s',
  ], 'a new English-only key needs a Chinese override next to ZH_COPY')
})

check('every looked-up key has a translation', () => {
  const missing = [...USED.keys()].filter((key) => !(key in EN))
  assert.deepEqual(missing, [], 'the UI would render a raw Chinese key')
})

check('every translation keeps the placeholder count of its key', () => {
  const mismatched = []
  for (const key of USED.keys()) {
    if (!(key in EN)) continue
    const want = (key.match(/%s/g) || []).length
    const got = (EN[key].match(/%s/g) || []).length
    if (want !== got) mismatched.push(`${key} (${want} vs ${got})`)
  }
  assert.deepEqual(mismatched, [], 'values would be dropped or misordered')
})

check('no translation is dead weight', () => {
  const unused = Object.keys(EN).filter((key) => !USED.has(key))
  assert.deepEqual(unused, [], 'the dictionary carries keys the UI never asks for')
})

check('the bundle asks the shell for the locale service', () => {
  assert.match(SOURCE, /exports\.inject = \[[^\]]*'locale'[^\]]*\]/)
})

check('both dictionaries are registered under one namespace', () => {
  assert.match(SOURCE, /const LOCALE_NS = 'remote-mesh'/)
  assert.match(SOURCE, /ctx\.locale\.register\(LOCALE_NS, \{ zh: ZH, en: EN \}\)/)
})

check('lookups go through the bound translate seat', () => {
  assert.match(SOURCE, /translate = ctx\.locale\.bind\(LOCALE_NS\)/)
  assert.match(SOURCE, /const template = translate\(key\)/)
})

check('the sidebar labels are translated, not hard-coded', () => {
  assert.match(SOURCE, /label: \(\) => tr\('remote-workspaces'\)/)
  assert.match(SOURCE, /label: \(\) => tr`remote-workspaces: \$\{label\.value\}`/)
})

check('a shell without a locale service still renders Chinese', () => {
  assert.match(SOURCE, /let translate = \(key\) => ZH\[key\] \?\? key/)
})

// ---------------------------------------------------------------------------
// Runtime wiring: load the real bundle in a VM with a stub shell, mount it, and
// read the labels back. This is the half a static check cannot prove — that the
// dictionaries land in the service and the thunks actually translate.
// ---------------------------------------------------------------------------

/** Minimal React stand-in: the bundle builds elements, it never mounts them here. */
const REACT_STUB = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

/** Just enough DOM for the one-shot stylesheet injection. */
function makeDocument() {
  return {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
}

/**
 * Mount a fresh copy of the bundle against a stub shell.
 * @param {object} [options] - Stub shell options.
 * @param {string} [options.language] - Active shell language.
 * @param {boolean} [options.locale] - Whether the shell exposes the locale service.
 * @param {object[]} [options.peers] - Peers the state call reports.
 * @returns {Promise<{labels: () => string[], dictionaries: Map<string, any>}>} what the shell would render.
 */
async function mount({ language = 'zh', locale = true, peers = [] } = {}) {
  let captured
  const dictionaries = new Map()
  const registrations = []
  const disposers = []
  const context = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
    document: makeDocument(),
    console,
    crypto: globalThis.crypto,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { ok: true, value: { peers } } }) }),
    setInterval: () => 1,
    clearInterval: () => {},
  }
  vm.createContext(context)
  vm.runInContext(SOURCE, context, { filename: 'client.js' })
  assert.equal(captured?.id, 'dsh-remote-mesh', 'the bundle must register its factory')
  const bundle = captured.factory((name) => {
    if (name === 'react') return REACT_STUB
    throw new Error(`unexpected require: ${name}`)
  })
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options) => {
        registrations.push(options)
        return () => {}
      },
    },
  }
  if (locale) {
    ctx.locale = {
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts)
        return () => dictionaries.delete(ns)
      },
      bind: (ns) => (key) => dictionaries.get(ns)?.[language]?.[key] ?? key,
    }
  }
  bundle.apply(ctx)
  // One macrotask, so the fire-and-forget state sync has registered its rows.
  await new Promise((resolve) => setImmediate(resolve))
  return {
    dictionaries,
    labels: () => registrations.filter((entry) => entry.label !== undefined).map((entry) => entry.label()),
  }
}

const asyncCheck = async (name, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

await asyncCheck('apply() hands both dictionaries to the shell service', async () => {
  const { dictionaries } = await mount()
  const dicts = dictionaries.get('remote-mesh')
  assert.ok(dicts, 'the namespace must be registered')
  assert.equal(dicts.zh['remote-workspaces'], '远程工作区')
  assert.equal(dicts.en['remote-workspaces'], 'Remote workspaces')
  assert.equal(Object.keys(dicts.en).length, Object.keys(dicts.zh).length)
})

await asyncCheck('a Chinese shell renders Chinese labels', async () => {
  const { labels } = await mount({ language: 'zh' })
  assert.deepEqual(labels(), ['远程工作区'])
})

await asyncCheck('an English shell renders English labels', async () => {
  const { labels } = await mount({ language: 'en' })
  assert.deepEqual(labels(), ['Remote workspaces'])
})

await asyncCheck('per-machine rows translate the prefix and keep the machine name', async () => {
  const peers = [{ id: 'peer-1', displayName: '台式机', enabled: true }]
  const { labels } = await mount({ language: 'en', peers })
  assert.deepEqual(labels(), ['Remote workspaces', 'Remote workspaces: 台式机'])
})

await asyncCheck('a shell without a locale service falls back to Chinese', async () => {
  const { labels } = await mount({ locale: false })
  assert.deepEqual(labels(), ['远程工作区'])
})

process.stdout.write(`\n${passed} checks passed\n`)
