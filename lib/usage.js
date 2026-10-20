/**
 * Usage summary for the remote-workspaces panel.
 *
 * The figures come from the optional `@linxin666/dsh-usage` plugin, which folds
 * live session usage into a ledger under the Harness home while probing each
 * configured provider's balance on its own poll cycle. This module only *reads*
 * those two files: the mesh never asks that plugin for anything, so a disabled
 * or absent usage plugin degrades to "no usage" instead of breaking a snapshot.
 *
 * Reading files another process is writing is safe here because that plugin
 * persists through an atomic rename, so a reader observes either the previous or
 * the next complete document and never a torn one.
 *
 * Cost is only meaningful for providers the usage plugin prices (the official
 * DeepSeek family); other providers accrue tokens with a zero cost, which is
 * reported as-is rather than guessed at.
 * @module dsh-remote-mesh/usage
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Directory the usage plugin keeps its state in, under the Harness home. */
const USAGE_DIR = 'dsh-usage'
/** Ledger file name inside that directory. */
const LEDGER_FILE = 'usage-ledger.json'
/** Provider balance snapshots file name inside that directory. */
const SNAPSHOTS_FILE = 'provider-snapshots.json'
/** Ledger schema version this reader understands. */
const LEDGER_VERSION = 1
/** How long a computed summary is reused, in ms. Polls are 20s by default. */
const CACHE_MS = 10_000
/** Calendar days of history carried in the summary, for the panel's sparkline. */
const RECENT_DAYS = 7
/** Token fields folded out of a ledger bucket. */
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

/** @type {Map<string, {at: number, value: Record<string, unknown>}>} */
const cache = new Map()

/**
 * Coerce one ledger counter to a finite number.
 * @param {unknown} value - Raw ledger value.
 * @returns {number} a non-negative count, or 0 when the value is unusable.
 */
function asCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * Round a cost to six decimals so repeated reads render identically.
 * @param {number} value - Raw accumulated cost.
 * @returns {number} the rounded cost.
 */
function asCost(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * An all-zero account of one slice of usage.
 * @returns {Record<string, number>} zeroed counters.
 */
function emptyTotals() {
  /** @type {Record<string, number>} */
  const totals = { cost: 0, calls: 0, totalTokens: 0 }
  for (const field of TOKEN_FIELDS) totals[field] = 0
  return totals
}

/**
 * Fold one ledger bucket (one model of one provider on one day) into a total.
 * @param {Record<string, number>} totals - Accumulator to mutate.
 * @param {unknown} bucket - The bucket to fold in.
 * @returns {void}
 */
function addBucket(totals, bucket) {
  if (typeof bucket !== 'object' || bucket === null) return
  const record = /** @type {Record<string, unknown>} */ (bucket)
  totals.cost += asCount(record.cost)
  totals.calls += asCount(record.calls)
  for (const field of TOKEN_FIELDS) {
    const value = asCount(record[field])
    totals[field] += value
    totals.totalTokens += value
  }
}

/**
 * Fold every provider and model of one day into a total.
 * @param {unknown} day - One ledger day.
 * @returns {Record<string, number>} the day's totals.
 */
function dayTotals(day) {
  const totals = emptyTotals()
  if (typeof day !== 'object' || day === null) return totals
  for (const provider of Object.values(/** @type {Record<string, unknown>} */ (day))) {
    if (typeof provider !== 'object' || provider === null) continue
    for (const bucket of Object.values(/** @type {Record<string, unknown>} */ (provider))) addBucket(totals, bucket)
  }
  return totals
}

/**
 * Format a timestamp as the ledger's local calendar key.
 * @param {number} epochMs - Instant to format.
 * @returns {string} `YYYY-MM-DD` in the host's local zone.
 */
function localDateKey(epochMs) {
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Read and parse one JSON document, reporting absence and breakage apart.
 * @param {string} file - Absolute path.
 * @returns {{ok: true, value: unknown} | {ok: false, missing: boolean}} the read outcome.
 */
function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    return { ok: false, missing: code === 'ENOENT' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, missing: false }
  }
}

/**
 * Pick the most recent provider balance out of the snapshots document.
 * @param {unknown} snapshots - Parsed `provider-snapshots.json`.
 * @returns {{currency: string, amount: number, provider: string, updatedAt: number} | null} the balance, when one is known.
 */
function latestBalance(snapshots) {
  if (typeof snapshots !== 'object' || snapshots === null) return null
  const providers = /** @type {Record<string, unknown>} */ (snapshots).providers
  if (typeof providers !== 'object' || providers === null) return null
  /** @type {{currency: string, amount: number, provider: string, updatedAt: number} | null} */
  let best = null
  for (const [provider, entry] of Object.entries(providers)) {
    if (typeof entry !== 'object' || entry === null) continue
    const balance = /** @type {Record<string, unknown>} */ (entry).balance
    if (typeof balance !== 'object' || balance === null) continue
    const amount = Number(/** @type {Record<string, unknown>} */ (balance).totalBalance)
    if (!Number.isFinite(amount)) continue
    const updatedAt = Number(/** @type {Record<string, unknown>} */ (balance).updatedAt) || 0
    const currency = typeof (/** @type {Record<string, unknown>} */ (balance).currency) === 'string'
      ? String(/** @type {Record<string, unknown>} */ (balance).currency)
      : 'CNY'
    // The official family is the one the voucher and the panel care about; any
    // other provider's balance only wins when no official one was probed.
    const preferred = provider.startsWith('deepseek')
    const incumbentPreferred = best !== null && best.provider.startsWith('deepseek')
    if (best === null || (preferred && !incumbentPreferred) || (preferred === incumbentPreferred && updatedAt > best.updatedAt)) {
      best = { currency, amount, provider, updatedAt }
    }
  }
  return best
}

/**
 * Build the `recent` series: one entry per calendar day, zero-filled, ascending.
 * @param {Record<string, unknown>} days - The ledger's day map.
 * @param {number} now - Reference instant.
 * @returns {{date: string, cost: number, calls: number, totalTokens: number}[]} the series.
 */
function recentSeries(days, now) {
  const series = []
  const cursor = new Date(now)
  cursor.setHours(12, 0, 0, 0)
  for (let offset = RECENT_DAYS - 1; offset >= 0; offset -= 1) {
    const point = new Date(cursor.getTime() - offset * 86_400_000)
    const date = localDateKey(point.getTime())
    const totals = dayTotals(days[date])
    series.push({ date, cost: asCost(totals.cost), calls: totals.calls, totalTokens: totals.totalTokens })
  }
  return series
}

/**
 * Compute a summary from a parsed ledger. Pure, so the test suite can drive it
 * with fixtures instead of touching the user's real usage.
 * @param {unknown} ledger - Parsed `usage-ledger.json`.
 * @param {unknown} snapshots - Parsed `provider-snapshots.json`, or undefined.
 * @param {{now?: number}} [options] - Reference instant.
 * @returns {Record<string, unknown>} the summary.
 */
export function summarizeUsage(ledger, snapshots, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const root = typeof ledger === 'object' && ledger !== null ? /** @type {Record<string, unknown>} */ (ledger) : {}
  if (root.version !== LEDGER_VERSION) {
    return { available: false, source: '@linxin666/dsh-usage', reason: 'usage ledger has an unsupported schema version', updatedAt: now }
  }
  const days = typeof root.days === 'object' && root.days !== null ? /** @type {Record<string, unknown>} */ (root.days) : {}
  const keys = Object.keys(days).sort()
  const total = emptyTotals()
  for (const key of keys) {
    const day = dayTotals(days[key])
    total.cost += day.cost
    total.calls += day.calls
    total.totalTokens += day.totalTokens
    for (const field of TOKEN_FIELDS) total[field] += day[field]
  }
  const todayKey = localDateKey(now)
  const today = dayTotals(days[todayKey])
  const balance = latestBalance(snapshots)
  for (const field of ['cost']) {
    total[field] = asCost(total[field])
    today[field] = asCost(today[field])
  }
  return {
    available: true,
    source: '@linxin666/dsh-usage',
    updatedAt: now,
    currency: balance === null ? 'CNY' : balance.currency,
    today: { date: todayKey, ...today },
    total: { ...total, days: keys.length },
    recent: recentSeries(days, now),
    balance,
  }
}

/**
 * Read this machine's usage summary, memoised briefly.
 *
 * Every peer polls a snapshot on the same cycle, so without the cache a single
 * panel refresh would re-read and re-parse the ledger once per peer.
 * @param {{home: string, now?: number, force?: boolean}} options - Harness home and reference instant.
 * @returns {Record<string, unknown>} the summary; `available: false` with a `reason` when usage is not observable.
 */
export function readUsageSummary(options) {
  const home = path.resolve(options.home)
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const hit = cache.get(home)
  if (options.force !== true && hit !== undefined && now - hit.at < CACHE_MS) return hit.value

  const ledgerRead = readJson(path.join(home, USAGE_DIR, LEDGER_FILE))
  let value
  if (!ledgerRead.ok) {
    value = {
      available: false,
      source: '@linxin666/dsh-usage',
      reason: ledgerRead.missing ? 'dsh-usage 未安装或还没有记录过用量' : '用量账本无法解析',
      updatedAt: now,
    }
  } else {
    const snapshotsRead = readJson(path.join(home, USAGE_DIR, SNAPSHOTS_FILE))
    value = summarizeUsage(ledgerRead.value, snapshotsRead.ok ? snapshotsRead.value : undefined, { now })
  }
  cache.set(home, { at: now, value })
  return value
}

/**
 * Drop the memoised summaries. The plugin calls this when its own state changes,
 * and the test suite uses it between fixtures.
 * @returns {void}
 */
export function clearUsageCache() {
  cache.clear()
}
