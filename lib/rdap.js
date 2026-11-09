/**
 * RDAP availability queries with IANA bootstrap discovery.
 *
 * `rdap.org` is a convenience redirector and can be rate-limited or blocked (it
 * sits behind bot protection). The authoritative route is the IANA bootstrap
 * registry, which maps each TLD to its registry's RDAP base URL; queries then go
 * straight to that registry. rdap.org stays as the fallback for TLDs missing
 * from the bootstrap or when the bootstrap itself cannot be fetched.
 */
import { requestText } from './http.js'

export const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json'
export const FALLBACK_BASE = 'https://rdap.org/'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

let cache = null

/** Drop the cached bootstrap (tests, or long-running processes after a TLD change). */
export function resetRdapCache() {
  cache = null
}

function normalizeBase(base) {
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * TLD → RDAP base URL list from the IANA bootstrap registry.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, force?: boolean}} [options]
 * @returns {Promise<Map<string, string[]>>}
 */
export async function loadBootstrap({ fetchImpl, timeoutMs = 15_000, force = false } = {}) {
  if (!force && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.services
  const text = await requestText(IANA_BOOTSTRAP, { fetchImpl, timeoutMs })
  const payload = JSON.parse(text)
  const services = new Map()
  for (const entry of payload.services ?? []) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [tlds, bases] = entry
    if (!Array.isArray(bases) || bases.length === 0) continue
    const normalized = bases.map(normalizeBase)
    for (const tld of tlds ?? []) services.set(String(tld).toLowerCase(), normalized)
  }
  // An empty map means the payload was unusable; caching it would disable registry
  // lookups for the whole process.
  if (services.size > 0) cache = { at: Date.now(), services }
  return services
}

/**
 * Candidate RDAP base URLs for a domain, most authoritative first.
 * @param {string} name
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function rdapBasesFor(name, { fetchImpl } = {}) {
  const tld = name.split('.').pop()
  try {
    const services = await loadBootstrap({ fetchImpl })
    const bases = services.get(tld)
    if (bases && bases.length > 0) return [...bases, normalizeBase(FALLBACK_BASE)]
  } catch {
    // Bootstrap unavailable: fall through to the redirector.
  }
  return [normalizeBase(FALLBACK_BASE)]
}
