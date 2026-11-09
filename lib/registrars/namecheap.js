/**
 * Namecheap XML API client.
 *
 * API reference: https://www.namecheap.com/support/api/
 * Credentials: ApiUser + ApiKey + UserName + ClientIp (the caller IP must be
 * allow-listed in the Namecheap API settings). Responses are XML.
 *
 * The client is read-only on purpose: this plugin tracks a portfolio, it never
 * registers or transfers anything.
 */
import { requestText, redact } from '../http.js'
import { parseXml, findAll, findFirst, attr, textOf } from '../xml.js'
import { normalizeDomain, round2 } from '../store.js'

export const REGISTRAR = 'Namecheap'
export const LIVE_BASE = 'https://api.namecheap.com/xml.response'
export const SANDBOX_BASE = 'https://api.sandbox.namecheap.com/xml.response'

/** @typedef {{apiUser?: string, apiKey?: string, userName?: string, clientIp?: string, sandbox?: boolean, timeoutsMs?: number}} NamecheapConfig */

export function isConfigured(config = {}) {
  return Boolean(config.apiUser && config.apiKey && config.clientIp)
}

function requireConfig(config) {
  if (!isConfigured(config)) {
    throw new Error(
      'Namecheap API is not configured: set apiUser, apiKey and clientIp (config.namecheap or NAMECHEAP_API_USER / NAMECHEAP_API_KEY / NAMECHEAP_CLIENT_IP), and allow-list that IP in Namecheap API settings',
    )
  }
}

function buildUrl(config, command, params = {}) {
  const base = config.sandbox ? SANDBOX_BASE : LIVE_BASE
  const search = new URLSearchParams({
    ApiUser: config.apiUser,
    ApiKey: config.apiKey,
    UserName: config.userName ?? config.apiUser,
    ClientIp: config.clientIp,
    Command: command,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  })
  return `${base}?${search.toString()}`
}

function interpret(xml, { command, url, apiKey }) {
  const root = parseXml(xml)
  const status = attr(root, 'Status') ?? ''
  if (status.toLowerCase() !== 'ok') {
    const errors = findAll(root, 'Error').map((node) => `${attr(node, 'Number') ?? ''} ${textOf(node)}`.trim())
    throw new Error(`Namecheap ${command} failed: ${redact(errors.join('; ') || `status ${status}`, [apiKey])} (${redact(url)})`)
  }
  return root
}

function normalizeDate(value) {
  const text = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) return `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`
  const isoish = new Date(text)
  if (!Number.isNaN(isoish.getTime())) return isoish.toISOString().slice(0, 10)
  return null
}

const PRICING_CACHE = new Map()
const PRICING_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The registrable TLD of a domain, preferring the longest known suffix so multi-label
 * TLDs like `co.uk` win over `uk`.
 * @param {string} name
 * @param {Iterable<string>} [knownTlds] TLDs the pricing feed knows about
 * @returns {string|null}
 */
export function tldOf(name, knownTlds = []) {
  const labels = String(name ?? '').toLowerCase().split('.').filter(Boolean)
  if (labels.length < 2) return null
  const known = new Set([...knownTlds].map((tld) => String(tld).toLowerCase()))
  for (let size = Math.min(labels.length - 1, 4); size >= 1; size -= 1) {
    const candidate = labels.slice(-size).join('.')
    if (known.has(candidate)) return candidate
  }
  return labels[labels.length - 1] ?? null
}

function priceFrom(node) {
  const price = attr(node, 'Price')
  if (price === null || price.trim() === '') return null
  const current = Number(price)
  if (!Number.isFinite(current) || current < 0) return null
  const regularValue = Number(attr(node, 'RegularPrice'))
  const regular = Number.isFinite(regularValue) && regularValue > 0 ? regularValue : current
  const feeValue = Number(attr(node, 'AdditionalCost'))
  return {
    renewalPrice: round2(regular > current ? regular : current),
    promoPrice: regular > current ? round2(current) : null,
    icannFee: Number.isFinite(feeValue) && feeValue > 0 ? round2(feeValue) : null,
    currency: 'USD',
  }
}

function filterPricing(pricing, tlds) {
  const wanted = tlds ? new Set([...tlds].map((tld) => String(tld).toLowerCase())) : null
  const out = new Map()
  for (const [tld, price] of pricing) if (!wanted || wanted.has(tld)) out.set(tld, { ...price })
  return out
}

/**
 * Yearly renewal pricing for the account, per TLD.
 *
 * Namecheap has no per-domain renewal quote in its API, so this uses
 * `namecheap.users.getPricing` (ProductType=DOMAIN, ActionName=RENEW), which returns
 * the account's own rates for every TLD: the regular yearly price, the currently
 * charged price when the TLD is on promotion, and the per-year ICANN fee Namecheap
 * adds on top (null for ccTLDs without one).
 *
 * The full feed is ~3 MB, so successful responses are cached in-process for
 * `maxAgeMs` (6 h by default) to keep repeat syncs cheap.
 *
 * @param {NamecheapConfig} config
 * @param {{fetchImpl?: typeof fetch, maxAgeMs?: number, tlds?: Iterable<string>}} [options]
 * @returns {Promise<Map<string, {renewalPrice: number, promoPrice: number|null, icannFee: number|null, currency: string}>>}
 */
export async function getRenewPricing(config, { fetchImpl, maxAgeMs = PRICING_TTL_MS, tlds = null } = {}) {
  requireConfig(config)
  const cacheKey = JSON.stringify([Boolean(config.sandbox), config.apiUser, config.userName ?? config.apiUser])
  const cached = PRICING_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.at < maxAgeMs) return filterPricing(cached.pricing, tlds)

  const url = buildUrl(config, 'namecheap.users.getPricing', {
    ProductType: 'DOMAIN',
    ProductCategory: 'DOMAINS',
    ActionName: 'RENEW',
  })
  const xml = await requestText(url, { fetchImpl, timeoutMs: Math.max(config.timeoutsMs ?? 20_000, 45_000) })
  const root = interpret(xml, { command: 'namecheap.users.getPricing', url, apiKey: config.apiKey })

  // ActionName=RENEW already narrows the response to the renew category; fall back to
  // every category only if the API ignored the filter.
  const categories = findAll(root, 'ProductCategory')
  const renewCategories = categories.filter((category) => (attr(category, 'Name') ?? '').toLowerCase() === 'renew')
  const scopes = renewCategories.length > 0 ? renewCategories : categories

  const pricing = new Map()
  for (const category of scopes) {
    for (const product of findAll(category, 'Product')) {
      const tld = (attr(product, 'Name') ?? '').toLowerCase()
      if (!tld) continue
      const yearly = findAll(product, 'Price').find(
        (node) => (attr(node, 'DurationType') ?? '').toUpperCase() === 'YEAR' && (attr(node, 'Duration') ?? '1') === '1',
      )
      if (!yearly) continue
      const price = priceFrom(yearly)
      if (price) pricing.set(tld, price)
    }
  }
  if (pricing.size === 0) throw new Error('Namecheap getPricing returned no renewal prices')
  PRICING_CACHE.set(cacheKey, { at: Date.now(), pricing })
  return filterPricing(pricing, tlds)
}

/**
 * List every domain in the account.
 *
 * Registration facts only: Namecheap's list endpoint carries no price, so
 * `renewalPrice` is always null here and callers fill it from `getRenewPricing`.
 *
 * @param {NamecheapConfig} config
 * @param {{fetchImpl?: typeof fetch, pageSize?: number, maxPages?: number}} [options]
 * @returns {Promise<Array<{name: string, registrar: string, expires: string, autoRenew: boolean, premium: boolean, currency: string, renewalPrice: null}>>}
 */
export async function listDomains(config, { fetchImpl, pageSize = 100, maxPages = 50 } = {}) {
  requireConfig(config)
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new Error('pageSize and maxPages must be positive safe integers')
  }
  const domains = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url = buildUrl(config, 'namecheap.domains.getList', { PageSize: pageSize, Page: page })
    const xml = await requestText(url, { fetchImpl, timeoutMs: config.timeoutsMs ?? 20_000 })
    const root = interpret(xml, { command: 'namecheap.domains.getList', url, apiKey: config.apiKey })

    const result = findFirst(root, 'DomainGetListResult')
    if (!result) throw new Error('Namecheap getList returned no DomainGetListResult')
    const rows = findAll(result, 'Domain')
    for (const row of rows) {
      const name = attr(row, 'Name') ?? textOf(row)
      const expires = normalizeDate(attr(row, 'Expires') ?? textOf(row))
      const autoRenew = (attr(row, 'AutoRenew') ?? '').toLowerCase()
      if (!name || !expires || !['true', 'false'].includes(autoRenew)) throw new Error('Namecheap getList returned invalid registration facts')
      const domain = {
        name: name.trim().toLowerCase(),
        registrar: REGISTRAR,
        expires,
        autoRenew: autoRenew === 'true',
        premium: (attr(row, 'IsPremium') ?? '').toLowerCase() === 'true',
        currency: 'USD',
        renewalPrice: null,
      }
      normalizeDomain(domain)
      domains.push(domain)
    }

    const paging = findFirst(root, 'Paging')
    const total = Number(textOf(findFirst(paging ?? root, 'TotalItems')) || 0)
    if (rows.length < pageSize || (total > 0 && page * pageSize >= total)) return domains
    if (rows.length === 0) return domains
  }
  throw new Error(`Namecheap domain list exceeded maxPages (${maxPages}); refusing a partial sync`)
}

/**
 * Check availability for up to 20 domains per call (chunked internally).
 * @param {NamecheapConfig} config
 * @param {string[]} names
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function checkAvailability(config, names, { fetchImpl } = {}) {
  requireConfig(config)
  if (!Array.isArray(names) || names.length === 0) throw new Error('checkAvailability needs at least one domain')
  const results = []
  for (let index = 0; index < names.length; index += 20) {
    const chunk = names.slice(index, index + 20)
    const url = buildUrl(config, 'namecheap.domains.check', { DomainList: chunk.join(',') })
    const xml = await requestText(url, { fetchImpl, timeoutMs: config.timeoutsMs ?? 20_000 })
    const root = interpret(xml, { command: 'namecheap.domains.check', url, apiKey: config.apiKey })
    for (const node of findAll(root, 'DomainCheckResult')) {
      const name = (attr(node, 'Domain') ?? '').toLowerCase()
      const errorText = [attr(node, 'ErrorNo'), textOf(node)].filter((part) => part && part !== '0').join(' ')
      if (errorText) throw new Error(`Namecheap availability failed for ${name || 'unknown domain'}: ${redact(errorText, [config.apiKey])}`)
      const available = (attr(node, 'Available') ?? '').toLowerCase()
      if (!name || !['true', 'false'].includes(available)) throw new Error('Namecheap availability returned an invalid domain result')
      results.push({
        name,
        available: available === 'true',
        premium: (attr(node, 'IsPremium') ?? '').toLowerCase() === 'true',
        registrationPrice: attr(node, 'PremiumRegistrationPrice') ?? null,
        premiumPrice: attr(node, 'PremiumPrice') ?? null,
        currency: 'USD',
        source: 'namecheap',
        detail: errorText.length > 0 ? errorText : null,
      })
    }
  }
  return results
}
