/**
 * Domain portfolio data layer: validation, persistence and derived costs.
 *
 * Pure functions only (no cordis imports, no network) so the logic is unit-testable
 * with `node --test` outside the Harness runtime.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DATA_VERSION = 1

/** @typedef {{
 *   name: string, registrar: string, expires: string, autoRenew: boolean,
 *   renewalPrice: number|null, currency: string, promoPrice: number|null,
 *   icannFee: number|null, purpose: string|null, group: string|null, notes: string|null,
 *   source: string|null, syncedAt: string|null, transfer?: object
 * }} Domain */
/** @typedef {{version: number, updatedAt: string, domains: Domain[]}} DomainData */

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const TRANSFER_STATES = ['pending', 'in_progress', 'action_required', 'blocked', 'succeeded', 'failed']

export function isTransferActive(transfer) {
  return Boolean(transfer && ['submitting', 'pending', 'in_progress', 'action_required', 'blocked'].includes(transfer.state))
}

function normalizeTransfer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('transfer must be an object')
  if (input.from !== 'Namecheap' || input.to !== 'Cloudflare') fail('unsupported transfer route')
  if (!['ready', 'ineligible', 'submitting', ...TRANSFER_STATES].includes(input.state)) fail('invalid transfer state')
  for (const key of ['accountId', 'quoteId']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) fail(`transfer.${key} must be a non-empty string`)
  }
  for (const key of ['checkedAt', 'updatedAt']) {
    if (typeof input[key] !== 'string' || !Number.isFinite(Date.parse(input[key]))) fail(`transfer.${key} must be a timestamp`)
  }
  if (typeof input.autoRenew !== 'boolean') fail('transfer.autoRenew must be a boolean')
  if (!Array.isArray(input.reasons) || input.reasons.some((reason) => typeof reason !== 'string')) fail('transfer.reasons must be strings')
  const out = Object.fromEntries(
    ['from', 'to', 'state', 'accountId', 'quoteId', 'checkedAt', 'updatedAt', 'autoRenew'].map((key) => [key, input[key]]),
  )
  out.reasons = [...input.reasons]
  if (input.warnings !== undefined) {
    if (!Array.isArray(input.warnings) || input.warnings.some((warning) => typeof warning !== 'string')) {
      fail('transfer.warnings must be strings')
    }
    out.warnings = [...input.warnings]
  }
  if (input.state !== 'ineligible') {
    for (const key of ['transferPrice', 'renewalPrice']) {
      assertMoney(input[key], `transfer.${key}`)
      out[key] = input[key]
    }
    if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) fail('transfer.currency must be a currency code')
    out.currency = input.currency
  }
  if (input.message !== undefined) {
    if (typeof input.message !== 'string') fail('transfer.message must be a string')
    out.message = input.message
  }
  return out
}

/** @returns {DomainData} */
export function emptyData() {
  return { version: DATA_VERSION, updatedAt: new Date().toISOString(), domains: [] }
}

function fail(message) {
  throw new Error(message)
}

export function assertDate(value, field = 'expires') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail(`${field} must be a YYYY-MM-DD date`)
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`${field} is not a real date: ${value}`)
}

function assertMoney(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${field} must be a non-negative number`)
}

export function normalizeName(name) {
  if (typeof name !== 'string') fail('name must be a string')
  return name.trim().toLowerCase()
}

function emptyToNull(value) {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed.length === 0 ? null : trimmed
}

function nullableMoney(value, field) {
  if (value === null || value === undefined) return null
  assertMoney(value, field)
  return round2(value)
}

/**
 * Validate and normalize one domain record. Unknown keys are ignored deliberately:
 * registrar sync passes richer upstream payloads, and only the portfolio fields are stored.
 * @param {object} input
 * @param {Domain} [existing]
 * @returns {Domain}
 */
export function normalizeDomain(input, existing) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('domain must be an object')
  const base = existing ?? {
    name: undefined, registrar: 'unknown', expires: undefined, autoRenew: false,
    renewalPrice: null, currency: 'USD', promoPrice: null, icannFee: null, purpose: null, group: null,
    notes: null, source: null, syncedAt: null,
  }
  const merged = { ...base, ...pickKnown(input) }

  if (!DOMAIN_RE.test(normalizeName(merged.name))) {
    fail(`name must be a lowercase FQDN like "example.com" (got ${JSON.stringify(merged.name)})`)
  }
  merged.name = normalizeName(merged.name)
  if (typeof merged.registrar !== 'string' || merged.registrar.trim().length === 0) fail('registrar must be a non-empty string')
  merged.registrar = merged.registrar.trim()
  assertDate(merged.expires)
  if (typeof merged.autoRenew !== 'boolean') fail('autoRenew must be a boolean')
  if (typeof merged.currency !== 'string' || merged.currency.trim().length === 0) fail('currency must be a non-empty string')
  for (const key of ['purpose', 'group', 'notes', 'source']) {
    if (merged[key] !== null && merged[key] !== undefined && typeof merged[key] !== 'string') fail(`${key} must be a string or null`)
  }
  if (merged.syncedAt !== null && merged.syncedAt !== undefined && typeof merged.syncedAt !== 'string') fail('syncedAt must be a string or null')

  return {
    name: merged.name,
    registrar: merged.registrar,
    expires: merged.expires,
    autoRenew: merged.autoRenew,
    renewalPrice: nullableMoney(merged.renewalPrice, 'renewalPrice'),
    currency: merged.currency.trim().toUpperCase(),
    promoPrice: nullableMoney(merged.promoPrice, 'promoPrice'),
    icannFee: nullableMoney(merged.icannFee, 'icannFee'),
    purpose: emptyToNull(merged.purpose),
    group: emptyToNull(merged.group),
    notes: emptyToNull(merged.notes),
    source: emptyToNull(merged.source),
    syncedAt: emptyToNull(merged.syncedAt),
    ...(merged.transfer === undefined ? {} : { transfer: normalizeTransfer(merged.transfer) }),
  }
}

const KNOWN_FIELDS = [
  'name', 'registrar', 'expires', 'autoRenew', 'renewalPrice', 'currency',
  'promoPrice', 'icannFee', 'purpose', 'group', 'notes', 'source', 'syncedAt', 'transfer',
]

function pickKnown(input) {
  const out = {}
  for (const key of KNOWN_FIELDS) if (Object.hasOwn(input, key)) out[key] = input[key]
  return out
}

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function assertData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('domain data must be a JSON object')
  if (data.version !== DATA_VERSION) fail(`unsupported domain data version: ${JSON.stringify(data.version)} (expected ${DATA_VERSION})`)
  if (!Array.isArray(data.domains)) fail('domain data requires a "domains" array')
  const seen = new Set()
  data.domains.forEach((domain, index) => {
    if (domain === null || typeof domain !== 'object') fail(`domains[${index}] must be an object`)
    data.domains[index] = normalizeDomain(domain)
    if (seen.has(data.domains[index].name)) fail(`duplicate domain: ${data.domains[index].name}`)
    seen.add(data.domains[index].name)
  })
  if (typeof data.updatedAt !== 'string') data.updatedAt = new Date().toISOString()
  return data
}

/** Read the store; a missing file is an empty portfolio. */
export async function loadData(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyData()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`domain data file is not valid JSON (${file}): ${error.message}`)
  }
  return assertData(parsed)
}

/** Replace a file atomically, with owner-only access and cleanup on failure. */
export async function writeFileAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = join(dirname(file), `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}

/** Write the store atomically so readers never observe a partial file. */
export async function saveData(file, data) {
  const next = assertData({
    ...data,
    domains: Array.isArray(data.domains) ? [...data.domains] : data.domains,
    version: DATA_VERSION,
    updatedAt: new Date().toISOString(),
  })
  next.domains.sort((a, b) => a.name.localeCompare(b.name))
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export function findDomain(data, name) {
  const target = normalizeName(name)
  return data.domains.find((domain) => domain.name === target) ?? null
}

export function addDomain(data, input) {
  const domain = normalizeDomain(input)
  if (findDomain(data, domain.name)) fail(`domain already exists: ${domain.name} (use domain_manager_update)`)
  return { ...data, domains: [...data.domains, domain] }
}

export function updateDomain(data, name, patch) {
  const existing = findDomain(data, name)
  if (!existing) fail(`unknown domain: ${name} (use domain_manager_add)`)
  const updated = normalizeDomain({ ...pickKnown(patch), name: existing.name }, existing)
  return { ...data, domains: data.domains.map((domain) => (domain.name === existing.name ? updated : domain)) }
}

/** Insert or update, keeping locally curated fields (purpose, group, notes) when the caller omits them. */
export function upsertDomain(data, input) {
  const existing = findDomain(data, input.name)
  const merged = normalizeDomain(input, existing ?? undefined)
  if (existing) {
    return { ...data, domains: data.domains.map((domain) => (domain.name === merged.name ? merged : domain)) }
  }
  return { ...data, domains: [...data.domains, merged] }
}

export function removeDomain(data, name) {
  const target = normalizeName(name)
  if (!findDomain(data, target)) fail(`unknown domain: ${target}`)
  return { ...data, domains: data.domains.filter((domain) => domain.name !== target) }
}

/** @param {string} expires YYYY-MM-DD */
export function daysLeft(expires, today = new Date()) {
  const target = Date.parse(`${expires}T00:00:00Z`)
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target - todayUtc) / 86_400_000)
}

export function todayIso(today = new Date()) {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

function sumBy(domains, pick) {
  return round2(domains.reduce((total, domain) => total + pick(domain), 0))
}

function priced(domains) {
  return domains.filter((domain) => typeof domain.renewalPrice === 'number')
}

/**
 * Portfolio totals and upcoming renewals.
 * Costs use the regular renewal price; the promo price is reported separately so a
 * temporary discount never hides the steady-state bill.
 */
export function summarize(data, { today = new Date(), dueWithinDays = 90, staleAfterDays = 14 } = {}) {
  const domains = data.domains
  const withDays = domains.map((domain) => ({ ...domain, daysLeft: daysLeft(domain.expires, today) }))
  const withPrice = priced(domains)
  const autoOn = withPrice.filter((domain) => domain.autoRenew)
  const autoOff = withPrice.filter((domain) => !domain.autoRenew)

  const registrars = [...new Set(domains.map((domain) => domain.registrar))].sort()
  const byRegistrar = registrars.map((registrar) => {
    const rows = domains.filter((domain) => domain.registrar === registrar)
    return {
      registrar,
      count: rows.length,
      annual: sumBy(priced(rows), (domain) => domain.renewalPrice),
      autoRenewAnnual: sumBy(priced(rows).filter((domain) => domain.autoRenew), (domain) => domain.renewalPrice),
      icannFeesAnnual: sumBy(rows.filter((domain) => typeof domain.icannFee === 'number'), (domain) => domain.icannFee),
      unpriced: rows.length - priced(rows).length,
    }
  })

  const groups = [...new Set(domains.map((domain) => domain.group).filter(Boolean))].sort()
  const byGroup = groups.map((group) => {
    const rows = domains.filter((domain) => domain.group === group)
    return {
      group,
      count: rows.length,
      annual: sumBy(priced(rows), (domain) => domain.renewalPrice),
      autoRenewAnnual: sumBy(priced(rows).filter((domain) => domain.autoRenew), (domain) => domain.renewalPrice),
    }
  })

  const promos = domains.filter((domain) => typeof domain.promoPrice === 'number' && typeof domain.renewalPrice === 'number')
  const promoDelta = sumBy(promos, (domain) => domain.renewalPrice - domain.promoPrice)

  // Staleness: registrar-synced facts go out of date between syncs. Manual domains
  // have no syncedAt and are deliberately not counted as stale.
  const withSync = withDays.filter((domain) => domain.syncedAt)
  const stale = withSync
    .map((domain) => ({ ...domain, daysSinceSync: Math.max(0, -daysLeft(domain.syncedAt.slice(0, 10), today)) }))
    .filter((domain) => domain.daysSinceSync > staleAfterDays)
    .sort((a, b) => b.daysSinceSync - a.daysSinceSync)
  const syncDates = withSync.map((domain) => domain.syncedAt).sort()
  const staleness = {
    staleAfterDays,
    syncedCount: withSync.length,
    neverSyncedCount: domains.length - withSync.length,
    staleCount: stale.length,
    oldestSyncedAt: syncDates[0] ?? null,
    newestSyncedAt: syncDates[syncDates.length - 1] ?? null,
    staleDomains: stale.map((domain) => ({ name: domain.name, syncedAt: domain.syncedAt, daysSinceSync: domain.daysSinceSync })),
  }

  // ICANN fees are collected by the registrar on top of the renewal price and are
  // stored separately (Namecheap reports them per TLD), so the headline total stays
  // comparable to registrars that bundle fees into the price.
  const icannFeesAnnual = sumBy(domains.filter((domain) => typeof domain.icannFee === 'number'), (domain) => domain.icannFee)
  const totalAnnual = sumBy(withPrice, (domain) => domain.renewalPrice)
  const totalAnnualAtPromo = round2(totalAnnual - promoDelta)

  return {
    asOf: todayIso(today),
    count: domains.length,
    unpriced: domains.length - withPrice.length,
    totalAnnual,
    totalAnnualAtPromo,
    icannFeesAnnual,
    totalAnnualWithFees: round2(totalAnnual + icannFeesAnnual),
    totalAnnualAtPromoWithFees: round2(totalAnnualAtPromo + icannFeesAnnual),
    autoRenew: {
      on: { count: autoOn.length, annual: sumBy(autoOn, (domain) => domain.renewalPrice) },
      off: { count: autoOff.length, annual: sumBy(autoOff, (domain) => domain.renewalPrice) },
    },
    byRegistrar,
    byGroup,
    dueWithinDays,
    dueSoon: withDays
      .filter((domain) => domain.daysLeft >= 0 && domain.daysLeft <= dueWithinDays)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .map(expiryRow),
    expired: withDays.filter((domain) => domain.daysLeft < 0).sort((a, b) => a.daysLeft - b.daysLeft).map(expiryRow),
    promotion: promos.map((domain) => ({ name: domain.name, renewalPrice: domain.renewalPrice, promoPrice: domain.promoPrice })),
    staleness,
  }
}

function expiryRow(domain) {
  return {
    name: domain.name,
    registrar: domain.registrar,
    expires: domain.expires,
    daysLeft: domain.daysLeft,
    autoRenew: domain.autoRenew,
    renewalPrice: domain.renewalPrice,
  }
}
