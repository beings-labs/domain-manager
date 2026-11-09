/**
 * Cloudflare Registrar REST client (API v4).
 *
 * Endpoints (also exposed through Cloudflare MCP, which wraps the same API):
 *   GET  /accounts/{account_id}/registrar/domains          → registered domains + fees
 *   POST /accounts/{account_id}/registrar/domain-check     → real-time availability + pricing (≤20 domains)
 *   GET  /accounts/{account_id}/registrar/domain-search    → candidate discovery
 *
 * Auth: bearer API token. Read access to the domain list needs Registrar read
 * permission; the check/search beta endpoints need Registrar write.
 *
 * Read-only: this plugin never registers domains.
 */
import { requestText, parseJson, redact } from '../http.js'
import { normalizeDomain } from '../store.js'

export const REGISTRAR = 'Cloudflare'
export const API_BASE = 'https://api.cloudflare.com/client/v4'

/** @typedef {{apiToken?: string, accountId?: string, baseUrl?: string, timeoutsMs?: number}} CloudflareConfig */

export function isConfigured(config = {}) {
  return Boolean(config.apiToken && config.accountId)
}

function requireConfig(config) {
  if (!isConfigured(config)) {
    throw new Error(
      'Cloudflare API is not configured: set apiToken and accountId (config.cloudflare or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)',
    )
  }
}

function headers(config) {
  return { Authorization: `Bearer ${config.apiToken}`, Accept: 'application/json' }
}

function envelopeErrors(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  return errors.map((error) => `${error?.code ?? ''} ${error?.message ?? ''}`.trim()).filter(Boolean).join('; ')
}

async function callApi(config, path, { method = 'GET', body, fetchImpl } = {}) {
  const base = config.baseUrl ?? API_BASE
  const url = `${base}/accounts/${encodeURIComponent(config.accountId)}/registrar${path}`
  const text = await requestText(url, {
    method,
    headers: { ...headers(config), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: config.timeoutsMs ?? 20_000,
    fetchImpl,
  })
  const payload = parseJson(text, { url })
  if (payload?.success === false) {
    throw new Error(`Cloudflare API error on ${path}: ${redact(envelopeErrors(payload) || 'unknown error', [config.apiToken])}`)
  }
  if (payload?.success !== true) throw new Error(`Cloudflare API returned an invalid response on ${path}`)
  return payload
}

function domainResults(payload) {
  if (!Array.isArray(payload?.result?.domains)) throw new Error('Cloudflare API response requires a domains array')
  return payload.result.domains.map((row) => {
    if (!row || typeof row.name !== 'string' || !row.name.trim() || typeof row.registrable !== 'boolean') {
      throw new Error('Cloudflare API returned an invalid availability result')
    }
    return row
  })
}

function isoDate(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null
  return text.slice(0, 10)
}

/**
 * List every domain registered through Cloudflare Registrar.
 * @param {CloudflareConfig} config
 * @param {{fetchImpl?: typeof fetch, perPage?: number}} [options]
 */
export async function listDomains(config, { fetchImpl, perPage = 100 } = {}) {
  requireConfig(config)
  if (!Number.isSafeInteger(perPage) || perPage <= 0) throw new Error('perPage must be a positive safe integer')
  const domains = []
  // The Registrar /domains endpoint pages from 0: `page=1` is the *second* page,
  // so starting at 1 silently returns nothing whenever there is only one page.
  let page = 0
  let totalPages = 1
  do {
    const payload = await callApi(config, `/domains?per_page=${perPage}&page=${page}`, { fetchImpl })
    if (!Array.isArray(payload.result)) throw new Error('Cloudflare domain list response requires a result array')
    const rows = payload.result
    for (const row of rows) {
      const expires = isoDate(row.expires_at)
      if (!row.name || !expires || typeof row.auto_renew !== 'boolean') throw new Error('Cloudflare domain list returned invalid registration facts')
      const fees = row.fees ?? {}
      const domain = {
        name: String(row.name).trim().toLowerCase(),
        registrar: REGISTRAR,
        expires,
        autoRenew: Boolean(row.auto_renew),
        premium: row.premium_type !== undefined && row.premium_type !== 'not_premium',
        currency: typeof fees.currency === 'string' ? fees.currency : 'USD',
        renewalPrice: typeof fees.renewal_fee === 'number' ? fees.renewal_fee : null,
      }
      normalizeDomain(domain)
      domains.push(domain)
    }
    const reportedPages = payload.result_info?.total_pages
    totalPages = reportedPages === undefined ? 1 : Number(reportedPages)
    if (
      (reportedPages !== undefined && typeof reportedPages !== 'number' && typeof reportedPages !== 'string') ||
      (typeof reportedPages === 'string' && reportedPages.trim() === '') ||
      !Number.isSafeInteger(totalPages) || totalPages < 0
    ) throw new Error('Cloudflare returned an invalid total_pages value')
    page += 1
  } while (page < totalPages && totalPages > 0)
  return domains
}

/**
 * Check availability and pricing for up to 20 domains per request (chunked internally).
 * @param {CloudflareConfig} config
 * @param {string[]} names
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function checkAvailability(config, names, { fetchImpl } = {}) {
  requireConfig(config)
  if (!Array.isArray(names) || names.length === 0) throw new Error('checkAvailability needs at least one domain')
  const results = []
  for (let index = 0; index < names.length; index += 20) {
    const chunk = names.slice(index, index + 20)
    const payload = await callApi(config, '/domain-check', { method: 'POST', body: { domains: chunk }, fetchImpl })
    for (const row of domainResults(payload)) {
      results.push({
        name: row.name.trim().toLowerCase(),
        available: row.registrable,
        premium: row.tier !== undefined && row.tier !== 'standard',
        registrationPrice: row.pricing?.registration_cost ?? null,
        renewalPrice: row.pricing?.renewal_cost ?? null,
        currency: row.pricing?.currency ?? 'USD',
        source: 'cloudflare',
        detail: row.reason ?? null,
      })
    }
  }
  return results
}

/**
 * Discover domain candidates for a keyword search.
 * @param {CloudflareConfig} config
 * @param {string} query
 * @param {{fetchImpl?: typeof fetch, limit?: number}} [options]
 */
export async function searchDomains(config, query, { fetchImpl, limit = 5 } = {}) {
  requireConfig(config)
  const payload = await callApi(
    config,
    `/domain-search?q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 20)}`,
    { fetchImpl },
  )
  return domainResults(payload).map((row) => ({
    name: row.name.trim().toLowerCase(),
    available: row.registrable,
    premium: row.tier !== undefined && row.tier !== 'standard',
    registrationPrice: row.pricing?.registration_cost ?? null,
    renewalPrice: row.pricing?.renewal_cost ?? null,
    currency: row.pricing?.currency ?? 'USD',
  }))
}
