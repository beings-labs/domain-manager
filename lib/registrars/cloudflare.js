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
 * Transfer-in is billable and must only be invoked after explicit confirmation.
 * This plugin never registers new domains.
 */
import { HttpError, requestText, parseJson, redact } from '../http.js'
import { normalizeDomain, normalizeName, TRANSFER_STATES } from '../store.js'

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

/**
 * Turn common Cloudflare auth/permission failures into an actionable hint so the
 * caller can fix the cause instead of retrying blindly. Returns null when the
 * failure is not one of the known configuration problems.
 */
export function failureHint(status, text) {
  const body = String(text ?? '')
  if (/9109/.test(body)) {
    return 'Cloudflare rejected the API token from this machine\'s IP address (error 9109). Check the outbound IPv4/IPv6 address against the token\'s Client IP Address Filtering allowlist. Add only intended trusted addresses; keep IP filtering enabled.'
  }
  if (status === 401) {
    return 'Cloudflare rejected the API token (HTTP 401). The plugin reads CLOUDFLARE_API_TOKEN when DeepSeek Harness starts, so restart the app after editing ~/.dsh/.env. Also confirm the token has Registrar read/write, plus Zone read if you rely on zone checks.'
  }
  if (status === 403 && /zone[._]create/i.test(body)) {
    return 'Creating a zone needs an Account-scoped "Zone → Edit" API token policy; a Zone-type policy cannot grant it. Add the domain in the Cloudflare dashboard (Add a site) instead.'
  }
  if (status === 403) {
    return 'Cloudflare refused the token\'s permissions (HTTP 403). Confirm the token grants Registrar read/write for this account.'
  }
  if (status === 429) {
    return 'Cloudflare rate-limited the request (HTTP 429). Wait a moment and retry.'
  }
  return null
}

async function callApi(config, path, { method = 'GET', body, fetchImpl, sensitiveValues = [] } = {}) {
  const base = config.baseUrl ?? API_BASE
  const url = `${base}/accounts/${encodeURIComponent(config.accountId)}/registrar${path}`
  let text
  try {
    text = await requestText(url, {
      method,
      headers: { ...headers(config), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: config.timeoutsMs ?? 20_000,
      fetchImpl,
      sensitiveValues,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      const hint = failureHint(error.status, `${error.body ?? ''} ${error.message}`)
      if (hint) {
        throw new HttpError(`${error.message} — ${hint}`, { status: error.status, url: error.url, body: error.body })
      }
    }
    throw error
  }
  const payload = parseJson(text, { url })
  if (payload?.success === false) {
    const detail = redact(envelopeErrors(payload) || 'unknown error', [config.apiToken, ...sensitiveValues])
    const hint = failureHint(200, detail)
    throw new Error(`Cloudflare API error on ${path}: ${detail}${hint ? ` — ${hint}` : ''}`)
  }
  if (payload?.success !== true) throw new Error(`Cloudflare API returned an invalid response on ${path}`)
  return payload
}

function transferInput(name, authCode) {
  const normalized = normalizeName(name)
  normalizeDomain({ name: normalized, registrar: REGISTRAR, expires: '2000-01-01', autoRenew: false })
  if (authCode !== undefined && (typeof authCode !== 'string' || !authCode.trim())) throw new Error('authCode must be a non-empty string')
  if (!normalized.endsWith('.uk') && authCode === undefined) throw new Error('An authorization/EPP code from Namecheap is required')
  const encoded = authCode === undefined ? undefined : Buffer.from(authCode, 'utf8').toString('base64')
  return {
    name: normalized,
    auth: encoded === undefined ? {} : { auth_code: encoded },
    sensitiveValues: encoded === undefined ? [] : [authCode, encoded],
  }
}

function price(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error('Cloudflare transfer check returned invalid pricing')
  }
  return Number(value)
}

/** Read-only eligibility check; authCode is raw, not base64. */
export async function checkTransfer(config, name, authCode, { fetchImpl } = {}) {
  requireConfig(config)
  const input = transferInput(name, authCode)
  const payload = await callApi(config, '/domain-transfer-check', {
    method: 'POST', body: { domains: [{ domain_name: input.name, ...input.auth }] },
    sensitiveValues: input.sensitiveValues, fetchImpl,
  })
  const domains = payload.result?.domains
  const row = domains?.[input.name]
  if (
    !domains || Array.isArray(domains) || Object.keys(domains).length !== 1 ||
    !row || typeof row.transferable !== 'boolean' ||
    (row.name !== undefined && row.name !== input.name) ||
    (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))
  ) throw new Error('Cloudflare transfer check returned incomplete or invalid results')
  const reasons = row.reasons ?? []
  if (!Array.isArray(reasons) || reasons.some((reason) => !reason || typeof reason.code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(reason.code))) {
    throw new Error('Cloudflare transfer check returned invalid reasons')
  }
  if (!row.transferable) return { transferable: false, reasons: reasons.map((reason) => reason.code) }
  if (reasons.length > 0 || !/^[A-Z]{3}$/.test(row.pricing?.currency ?? '')) throw new Error('Cloudflare transfer check returned invalid pricing or reasons')
  return {
    transferable: true, reasons: [],
    transferPrice: price(row.pricing.transfer_cost),
    renewalPrice: price(row.pricing.renewal_cost),
    currency: row.pricing.currency,
  }
}

function workflow(payload, name, secrets = []) {
  const row = payload.result
  if (
    !row || !TRANSFER_STATES.includes(row.state) || typeof row.completed !== 'boolean' ||
    row.completed !== ['succeeded', 'failed'].includes(row.state) ||
    (row.context?.domain_name !== undefined && row.context.domain_name !== name)
  ) throw new Error('Cloudflare returned an invalid transfer workflow')
  if (row.state === 'failed' && (typeof row.error?.code !== 'string' || typeof row.error?.message !== 'string')) {
    throw new Error('Cloudflare transfer failure requires error details')
  }
  const messages = []
  if (row.error) messages.push(`${row.error.code}: ${row.error.message}`)
  if (row.context?.action !== undefined) messages.push(`Action required: ${JSON.stringify(row.context.action)}`)
  if (typeof row.context?.transfer_status === 'string') messages.push(row.context.transfer_status)
  if (row.context?.foa_required === true) messages.push('Approve the transfer authorization email.')
  return { state: row.state, message: redact(messages.join('; '), secrets) }
}

/** Billable. The caller must enforce confirmation and persist intent before calling. */
export async function startTransfer(config, name, authCode, autoRenew, { fetchImpl } = {}) {
  requireConfig(config)
  if (typeof autoRenew !== 'boolean') throw new Error('autoRenew must be a boolean')
  const input = transferInput(name, authCode)
  const payload = await callApi(config, `/registrations/${encodeURIComponent(input.name)}/transfer-in`, {
    method: 'POST', body: { ...input.auth, auto_renew: autoRenew },
    sensitiveValues: input.sensitiveValues, fetchImpl,
  })
  return workflow(payload, input.name, [config.apiToken, ...input.sensitiveValues])
}

export async function getTransferStatus(config, name, { fetchImpl } = {}) {
  requireConfig(config)
  const normalized = normalizeName(name)
  const payload = await callApi(config, `/registrations/${encodeURIComponent(normalized)}/transfer-in-status`, { fetchImpl })
  return workflow(payload, normalized, [config.apiToken])
}

/** Only return registration facts after the transfer has completed. */
export async function getRegistration(config, name, { fetchImpl } = {}) {
  requireConfig(config)
  const normalized = normalizeName(name)
  const payload = await callApi(config, `/registrations/${encodeURIComponent(normalized)}`, { fetchImpl })
  const row = payload.result
  if (row?.domain_name !== normalized || row.status !== 'active' || typeof row.auto_renew !== 'boolean' || !isoDate(row.expires_at)) {
    throw new Error('Cloudflare registration is not active or returned invalid registration facts; check transfer status again later')
  }
  return normalizeDomain({
    name: normalized, registrar: REGISTRAR, expires: isoDate(row.expires_at), autoRenew: row.auto_renew,
  })
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
 * Best-effort zone lookup used by the transfer UX to warn *before* submission
 * that a missing or pending zone would get the transfer rejected.
 *
 * The zones API needs Zone:Read rather than Registrar permissions. Callers may
 * report lookup failures as advisory warnings without failing eligibility checks.
 *
 * @param {CloudflareConfig} config
 * @param {string} name
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function getZoneStatus(config, name, { fetchImpl } = {}) {
  requireConfig(config)
  const normalized = normalizeName(name)
  const base = config.baseUrl ?? API_BASE
  const search = new URLSearchParams({ name: normalized, 'account.id': config.accountId, match: 'all' })
  const url = `${base}/zones?${search}`
  const text = await requestText(url, {
    headers: headers(config),
    timeoutMs: config.timeoutsMs ?? 20_000,
    fetchImpl,
  })
  const payload = parseJson(text, { url })
  if (payload?.success === false) {
    throw new Error(`Cloudflare zone lookup failed: ${redact(envelopeErrors(payload) || 'unknown error', [config.apiToken])}`)
  }
  if (
    payload?.success !== true || !Array.isArray(payload.result) ||
    (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))
  ) throw new Error('Cloudflare zone lookup returned an invalid response')
  if (payload.result.length === 0) return { found: false, status: 'missing', nameservers: [] }
  const zone = payload.result[0]
  if (
    payload.result.length !== 1 || typeof zone?.name !== 'string' || normalizeName(zone.name) !== normalized ||
    typeof zone.status !== 'string' || !zone.status.trim() ||
    (zone.account?.id !== undefined && zone.account.id !== config.accountId) ||
    (zone.name_servers !== undefined && (!Array.isArray(zone.name_servers) || zone.name_servers.some((server) => typeof server !== 'string' || !server.trim())))
  ) throw new Error('Cloudflare zone lookup returned invalid zone facts')
  return { found: true, status: zone.status, nameservers: zone.name_servers ?? [] }
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
