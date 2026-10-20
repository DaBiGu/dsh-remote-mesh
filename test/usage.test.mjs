/**
 * Direct checks for the usage reader: the figures the panel shows for this
 * machine and, through the snapshot, for its peers.
 *
 * Everything here is fixture-driven — no real Harness home, no LLM calls — so the
 * suite can assert the arithmetic, the degradation paths, and the cache exactly.
 * Run with `node test/usage.test.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { clearUsageCache, readUsageSummary, summarizeUsage } from '../lib/usage.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok   ${name}\n`)
}

/** A local noon on 2026-10-20, so the "today" key is the same in every zone. */
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime()

/** One model's bucket, with the fields the ledger actually persists. */
function bucket(overrides = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    cost: 0,
    ...overrides,
  }
}

/** Two days of usage: one with a fractional cost, one with a reasoning bucket. */
const LEDGER = {
  version: 1,
  days: {
    '2026-10-19': { 'deepseek-official': { 'deepseek-flash': bucket({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 4000, calls: 3, cost: 0.123456789 }) } },
    '2026-10-20': { 'deepseek-official': { 'deepseek-flash': bucket({ inputTokens: 2000, outputTokens: 800, cacheReadTokens: 6000, reasoningTokens: 100, calls: 5, cost: 0.25 }) } },
  },
}

/** A balance for the official family plus one for an unrelated provider. */
const SNAPSHOTS = {
  version: 1,
  providers: {
    'deepseek-official': { balance: { currency: 'CNY', totalBalance: '333.65', updatedAt: 1792477294516 } },
    moonshotai: { balance: { currency: 'USD', totalBalance: '7.00', updatedAt: 1792477299999 } },
  },
}

check('today folds every provider and model of the current local day', () => {
  const summary = summarizeUsage(LEDGER, SNAPSHOTS, { now: NOW })
  assert.equal(summary.available, true)
  assert.equal(summary.today.date, '2026-10-20')
  assert.equal(summary.today.cost, 0.25)
  assert.equal(summary.today.calls, 5)
  assert.equal(summary.today.totalTokens, 8900)
  assert.deepEqual(
    [summary.today.inputTokens, summary.today.outputTokens, summary.today.cacheReadTokens, summary.today.reasoningTokens],
    [2000, 800, 6000, 100],
  )
})

check('the total sums the retained days and keeps the day count', () => {
  const summary = summarizeUsage(LEDGER, SNAPSHOTS, { now: NOW })
  assert.equal(summary.total.days, 2)
  assert.equal(summary.total.calls, 8)
  assert.equal(summary.total.cost, 0.373457)
  assert.equal(summary.total.totalTokens, 1000 + 500 + 4000 + 8900)
})

check('recent is a zero-filled ascending week ending today', () => {
  const { recent } = summarizeUsage(LEDGER, SNAPSHOTS, { now: NOW })
  assert.equal(recent.length, 7)
  assert.equal(recent[6].date, '2026-10-20')
  assert.equal(recent[0].date, '2026-10-14')
  assert.deepEqual(recent.map((point) => point.date).slice().sort(), recent.map((point) => point.date))
  assert.equal(recent[0].calls, 0)
  assert.equal(recent[5].calls, 3)
  assert.equal(recent[5].cost, 0.123457)
  assert.equal(recent[6].totalTokens, 8900)
})

check('an unpriced provider still reports its tokens at zero cost', () => {
  const ledger = { version: 1, days: { '2026-10-20': { moonshotai: { 'kimi-k2': bucket({ inputTokens: 700, outputTokens: 300, calls: 2 }) } } } }
  const summary = summarizeUsage(ledger, undefined, { now: NOW })
  assert.equal(summary.today.cost, 0)
  assert.equal(summary.today.totalTokens, 1000)
  assert.equal(summary.today.calls, 2)
  assert.equal(summary.balance, null)
})

check('the balance prefers the official family and carries its currency', () => {
  const balance = summarizeUsage(LEDGER, SNAPSHOTS, { now: NOW }).balance
  assert.equal(balance.provider, 'deepseek-official')
  assert.equal(balance.currency, 'CNY')
  assert.equal(balance.amount, 333.65)
  assert.equal(summarizeUsage(LEDGER, SNAPSHOTS, { now: NOW }).currency, 'CNY')
})

check('an unknown ledger schema is refused rather than half-read', () => {
  const summary = summarizeUsage({ version: 2, days: LEDGER.days }, SNAPSHOTS, { now: NOW })
  assert.equal(summary.available, false)
  assert.match(String(summary.reason), /schema/)
})

check('an empty ledger is available with no usage, not an error', () => {
  const summary = summarizeUsage({ version: 1, days: {} }, undefined, { now: NOW })
  assert.equal(summary.available, true)
  assert.equal(summary.today.cost, 0)
  assert.equal(summary.total.calls, 0)
  assert.equal(summary.balance, null)
})

/** Build a throwaway Harness home for the filesystem-level checks. */
function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'mesh-usage-'))
}

check('an absent usage plugin reads as unavailable, not as zero spend', () => {
  const home = tempHome()
  try {
    const summary = readUsageSummary({ home, now: NOW, force: true })
    assert.equal(summary.available, false)
    assert.match(String(summary.reason), /未安装|没有记录/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

check('a corrupt ledger is reported as unreadable instead of crashing the snapshot', () => {
  const home = tempHome()
  try {
    const dir = path.join(home, 'dsh-usage')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'usage-ledger.json'), '{ not json', 'utf8')
    const summary = readUsageSummary({ home, now: NOW, force: true })
    assert.equal(summary.available, false)
    assert.match(String(summary.reason), /解析/)
  } finally {
    clearUsageCache()
    rmSync(home, { recursive: true, force: true })
  }
})

check('a real ledger on disk is read, and the cache serves the second read', () => {
  const home = tempHome()
  const dir = path.join(home, 'dsh-usage')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'usage-ledger.json'), JSON.stringify(LEDGER), 'utf8')
    writeFileSync(path.join(dir, 'provider-snapshots.json'), JSON.stringify(SNAPSHOTS), 'utf8')
    const first = readUsageSummary({ home, now: NOW })
    assert.equal(first.available, true)
    assert.equal(first.today.cost, 0.25)
    const second = readUsageSummary({ home, now: NOW + 1000 })
    assert.equal(second, first)
    const forced = readUsageSummary({ home, now: NOW + 1000, force: true })
    assert.notEqual(forced, first)
    assert.equal(forced.today.cost, 0.25)
  } finally {
    clearUsageCache()
    rmSync(home, { recursive: true, force: true })
  }
})

process.stdout.write(`\n${passed} checks passed\n`)
