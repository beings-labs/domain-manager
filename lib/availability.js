/**
 * Domain availability checks.
 *
 * Order of preference:
 *   1. Cloudflare Registrar `domain-check` (registry-accurate, returns pricing),
 *   2. Namecheap `domains.check` (returns premium pricing),
 *   3. RDAP (no credentials needed; 200 = registered, 404 = available).
 *
 * RDAP is the fallback that always works, so the capability is useful on a machine
 * with no registrar credentials at all.
 */
import { redact, requestText } from './http.js'
import { rdapBasesFor } from './rdap.js'
import * as cloudflare from './registrars/cloudflare.js'
import * as namecheap from './registrars/namecheap.js'

export const DEFAULT_RDAP_BASE = 'https://rdap.org/domain/'

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Normalize a user-supplied domain list: trim, lowercase, strip scheme/prefix/trailing dot. */
export function normalizeNames(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/)
  const names = []
  for (const raw of list) {
    const cleaned = String(raw)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '')
      .replace(/\.$/, '')
    if (!cleaned) continue
    if (!DOMAIN_RE.test(cleaned)) throw new Error(`not a valid domain name: ${JSON.stringify(raw)}`)
    if (!names.includes(cleaned)) names.push(cleaned)
  }
  if (names.length === 0) throw new Error('provide at least one domain name')
  if (names.length > 20) throw new Error('check at most 20 domains per call')
  return names
}

function validateResults(names, results) {
  if (!Array.isArray(results)) throw new Error('availability provider must return an array')
  const remaining = new Set(names)
  for (const row of results) {
    if (!row || typeof row.name !== 'string' || typeof row.available !== 'boolean') {
      throw new Error('availability provider returned an invalid domain result')
    }
    if (!remaining.delete(row.name)) throw new Error(`availability provider returned an unexpected or duplicate domain: ${row.name}`)
  }
  if (remaining.size > 0) throw new Error(`availability provider omitted domains: ${[...remaining].join(', ')}`)
  return results
}

/**
 * RDAP lookup for one domain.
 * @param {string} name
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, timeoutMs?: number}} [options]
 */
export async function checkViaRdap(name, { fetchImpl, baseUrl, timeoutMs = 15_000 } = {}) {
  // Registry-first: ask the domain's own RDAP service (from the IANA bootstrap)
  // before the rdap.org redirector, which is commonly rate-limited.
  const bases = baseUrl === undefined
    ? await rdapBasesFor(name, { fetchImpl })
    : [baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`]
  const failures = []
  for (const base of bases) {
    const url = `${base}domain/${encodeURIComponent(name)}`
    let text
    try {
      text = await requestText(url, { fetchImpl, timeoutMs })
    } catch (error) {
      if (error?.status === 404) {
        return { name, available: true, status: 'available', source: 'rdap', detail: 'no RDAP record (404)' }
      }
      failures.push(`${base}: ${error?.status ? `HTTP ${error.status}` : error.message}`)
      continue
    }
    let expires = null
    try {
      const payload = JSON.parse(text)
      const events = Array.isArray(payload?.events) ? payload.events : []
      const expiration = events.find((event) => event?.eventAction === 'expiration')
      if (expiration?.eventDate) expires = String(expiration.eventDate).slice(0, 10)
    } catch {
      // A registered domain with an unparsable body still counts as registered.
    }
    return { name, available: false, status: 'registered', source: 'rdap', expires, detail: null }
  }
  throw new Error(`RDAP lookup failed for ${name} (${failures.join('; ')})`)
}

/**
 * Check availability for a list of names, preferring registrar APIs when configured.
 * @param {string[]} input
 * @param {object} options
 * @param {{apiToken?: string, accountId?: string}} [options.cloudflare]
 * @param {{apiUser?: string, apiKey?: string, clientIp?: string}} [options.namecheap]
 * @param {'auto'|'cloudflare'|'namecheap'|'rdap'} [options.provider]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function checkAvailability(input, options = {}) {
  const names = normalizeNames(input)

  // Caller-supplied providers (e.g. a registrar MCP server before HTTP fallbacks)
  // are tried in the given order; the first answer wins.
  if (Array.isArray(options.providers)) {
    if (options.providers.length === 0) throw new Error('no availability provider is configured')
    const customReasons = []
    for (const provider of options.providers) {
      try {
        return { provider: provider.name, results: validateResults(names, await provider.run(names)), warnings: customReasons }
      } catch (error) {
        customReasons.push(redact(`${provider.name}: ${error.message}`))
        if (options.providers.length === 1) throw error
      }
    }
    throw new Error(`no availability provider could answer (${customReasons.join('; ')})`)
  }

  const { cloudflare: cfConfig, namecheap: ncConfig, provider = 'auto', fetchImpl } = options
  const reasons = []
  const warnings = []

  const candidates = provider === 'auto' ? ['cloudflare', 'namecheap', 'rdap'] : [provider]
  for (const candidate of candidates) {
    try {
      if (candidate === 'cloudflare') {
        if (!cloudflare.isConfigured(cfConfig)) {
          reasons.push('cloudflare: not configured')
          continue
        }
        const rows = await cloudflare.checkAvailability(cfConfig, names, { fetchImpl })
        return { provider: 'cloudflare', results: validateResults(names, rows), warnings }
      }
      if (candidate === 'namecheap') {
        if (!namecheap.isConfigured(ncConfig)) {
          reasons.push('namecheap: not configured')
          continue
        }
        const rows = await namecheap.checkAvailability(ncConfig, names, { fetchImpl })
        return { provider: 'namecheap', results: validateResults(names, rows), warnings }
      }
      if (candidate === 'rdap') {
        const results = []
        for (const name of names) results.push(await checkViaRdap(name, { fetchImpl }))
        return { provider: 'rdap', results: validateResults(names, results), warnings }
      }
      throw new Error(`unknown availability provider: ${candidate}`)
    } catch (error) {
      const reason = redact(`${candidate}: ${error.message}`)
      reasons.push(reason)
      warnings.push(reason)
      if (provider !== 'auto') throw error
    }
  }
  throw new Error(`no availability provider could answer (${reasons.join('; ')})`)
}
