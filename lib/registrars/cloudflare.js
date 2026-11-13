/**
 * Cloudflare Registrar client (API v4).
 *
 * Endpoints (also exposed through Cloudflare MCP, which wraps the same API):
 *   GET  /accounts/{account_id}/registrar/registrations    → registered domains (no renewal fees)
 *   POST /accounts/{account_id}/registrar/domain-check     → real-time availability + pricing (≤20 domains)
 *   GET  /accounts/{account_id}/registrar/domain-search    → candidate discovery
 *
 * Two transports reach them, selected by the config object:
 *   - `apiToken` (+ `accountId`): bearer-token REST requests, the default.
 *   - `transport` (Cloudflare MCP browser login): requests run inside the
 *     official Cloudflare MCP server, which authenticates through OAuth. See
 *     `lib/providers/cloudflare-connector.js`.
 * Validation, pricing and transfer reasoning are shared, so both transports
 * return identical results.
 *
 * Auth: bearer API token, or the MCP connection's OAuth grant. Read access to
 * the domain list needs Registrar read permission; the check/search beta
 * endpoints need Registrar write.
 *
 * Transfer-in is billable and must only be invoked after explicit confirmation.
 * This plugin never registers new domains.
 */
import { HttpError, requestText, parseJson, redact } from '../http.js'
import { normalizeDomain, normalizeName, TRANSFER_STATES } from '../store.js'

export const REGISTRAR = 'Cloudflare'
export const API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * @typedef {object} CloudflareTransportRequest
 * @property {string} method
 * @property {string} path API path starting with / (below the v4 base URL)
 * @property {Record<string, string|number>} [query]
 * @property {unknown} [body]
 * @property {string[]} [sensitiveValues]
 *
 * @typedef {object} CloudflareConfig
 * @property {string} [apiToken] REST bearer token (API mode)
 * @property {string} [accountId] Account id; discovered on demand in MCP mode
 * @property {string} [baseUrl] Override the API base URL (API mode)
 * @property {number} [timeoutsMs]
 * @property {(request: CloudflareTransportRequest) => Promise<object>} [transport]
 *   Cloudflare MCP transport; when set, REST credentials are never used.
 * @property {() => Promise<string>} [discoverAccountId]
 *   MCP mode only: resolve the account id when none is configured.
 */

/** API-token REST access: a token plus the account it acts on. */
export function isConfigured(config = {}) {
  return Boolean(config.apiToken && config.accountId)
}

/** Access through the Cloudflare MCP browser-login transport. */
export function isMcp(config = {}) {
  return typeof config?.transport === 'function'
}

/** Usable through either transport (an MCP config may still discover its account id). */
export function isReady(config = {}) {
  return isMcp(config) || isConfigured(config)
}

function requireConfig(config) {
  if (isReady(config)) return
  throw new Error(
    'Cloudflare API is not configured: set apiToken and accountId (config.cloudflare or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID), or connect the Cloudflare MCP browser login (@beings-labs/dsh-cloudflare-connector)',
  )
}

/**
 * The account the calls act on. In MCP mode the id can be discovered from the
 * authorized connection when the user did not configure one; it is written back
 * to the config object because transfer quotes persist it.
 */
export async function resolveAccountId(config = {}) {
  const configured = typeof config.accountId === 'string' ? config.accountId.trim() : ''
  if (configured) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(configured)) throw new Error('Cloudflare accountId has an unexpected format')
    return configured
  }
  if (isMcp(config) && typeof config.discoverAccountId === 'function') {
    const discovered = await config.discoverAccountId()
    if (typeof discovered !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(discovered.trim())) {
      throw new Error('Cloudflare account id could not be resolved from the MCP connection; set cloudflare.accountId or CLOUDFLARE_ACCOUNT_ID')
    }
    config.accountId = discovered.trim()
    return config.accountId
  }
  throw new Error(
    'Cloudflare accountId is required: set cloudflare.accountId or CLOUDFLARE_ACCOUNT_ID (the Cloudflare MCP browser login can discover it when it is omitted)',
  )
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
 *
 * @param {number|null} status
 * @param {string} text
 * @param {{mode?: 'api'|'mcp', method?: string, path?: string}} [options] which request produced the failure
 */
export function failureHint(status, text, { mode = 'api', method, path } = {}) {
  const body = String(text ?? '')
  const authenticationError = /"code"\s*:\s*10000\b|\b10000\s+Authentication error\b/i.test(body)
  if (mode === 'mcp') {
    if (status === 401 || status === 403 || authenticationError) {
      const registrarRead = method === 'GET' && /^\/accounts\/[^/]+\/registrar\/registrations(?:\?|$)/.test(path ?? '')
      const scope = registrarRead ? 'registrar-domains.read'
        : /^\/accounts\/[^/]+\/registrar\//.test(path ?? '') ? 'registrar-domains.admin'
          : path === '/zones' ? 'zone.read' : null
      return (
        `The Cloudflare MCP request was refused (${authenticationError ? 'Authentication error 10000' : `HTTP ${status}`}). ` +
        'No scope challenge was supplied. Run cloudflare_connector_status to inspect the actual granted scopes and connection, and check account access and endpoint permissions/availability. ' +
        'Another identity-only sign-in may not fix this.' +
        (scope
          ? ` This endpoint can require "${scope}"; if missing, request it with cloudflare_connector_authorize {"scopes":["${scope}"]} when no consent flow is pending, approve consent, then explicitly retry. If already granted, do not repeatedly reconnect.`
          : '')
      )
    }
    if (status === 429) return 'Cloudflare rate-limited the MCP request (HTTP 429). Wait a moment and retry.'
    return null
  }
  if (/9109/.test(body)) {
    return 'Cloudflare rejected the API token from this machine\'s IP address (error 9109). Check the outbound IPv4/IPv6 address against the token\'s Client IP Address Filtering allowlist. Add only intended trusted addresses; keep IP filtering enabled.'
  }
  if (status === 401 || authenticationError) {
    return `Cloudflare rejected the API token (${status === 401 ? 'HTTP 401' : 'Authentication error 10000'}). ` +
      'This request used the API-token transport: "auto" prefers configured API credentials and does not switch to OAuth after a failure. ' +
      'Fix cloudflare.apiToken (or CLOUDFLARE_API_TOKEN). The plugin reads credentials when DeepSeek Harness starts, so restart the app after editing config or ~/.dsh/.env. ' +
      'Also confirm the token has Registrar read/write, plus Zone read if you rely on zone checks. ' +
      'To use the installed connector\'s separate OAuth grant instead, explicitly set providers.cloudflare to "mcp"; it still needs Registrar consent. Never paste tokens into chat.'
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

/**
 * One Cloudflare API request in whichever transport the config selects, returning
 * the parsed v4 response envelope.
 *
 * The MCP connector supplies structured error status and authorization details.
 */
async function rawCall(config, { method = 'GET', path, query, body, fetchImpl, sensitiveValues = [] } = {}) {
  const verb = String(method).toUpperCase()
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Cloudflare request path must start with /')

  if (isMcp(config)) {
    try {
      return await config.transport({ method: verb, path, query, body, sensitiveValues })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : null
      const detail = redact(error?.message ?? String(error), sensitiveValues)
      const hint = error.code === 'authorization_required' ? null : failureHint(status, detail, { mode: 'mcp', method: verb, path })
      throw new HttpError(`${detail}${hint ? ` — ${hint}` : ''}`, {
        status,
        url: error?.url ?? null,
        body: error instanceof HttpError ? error.body : detail,
        code: error.code,
        scopes: error.scopes,
        authorizationUrl: error.authorizationUrl,
      })
    }
  }

  const base = config.baseUrl ?? API_BASE
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  let text
  try {
    text = await requestText(url.toString(), {
      method: verb,
      headers: { ...headers(config), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: config.timeoutsMs ?? 20_000,
      fetchImpl,
      sensitiveValues,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      const hint = failureHint(error.status, `${error.body ?? ''} ${error.message}`, { mode: 'api' })
      if (hint) {
        throw new HttpError(`${error.message} — ${hint}`, { status: error.status, url: error.url, body: error.body })
      }
    }
    throw error
  }
  return parseJson(text, { url })
}

async function callApi(config, path, { method = 'GET', query, body, fetchImpl, sensitiveValues = [] } = {}) {
  requireConfig(config)
  const accountId = await resolveAccountId(config)
  const payload = await rawCall(config, {
    method,
    path: `/accounts/${encodeURIComponent(accountId)}/registrar${path}`,
    query,
    body,
    fetchImpl,
    sensitiveValues,
  })
  if (payload?.success === false) {
    const detail = redact(envelopeErrors(payload) || 'unknown error', [config.apiToken, ...sensitiveValues])
    const hint = failureHint(200, detail, {
      mode: isMcp(config) ? 'mcp' : 'api', method, path: `/accounts/${encodeURIComponent(accountId)}/registrar${path}`,
    })
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
export async function listDomains(config, { fetchImpl, perPage = 50 } = {}) {
  requireConfig(config)
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 50) throw new Error('perPage must be an integer between 1 and 50')
  const domains = []
  const cursors = new Set()
  let cursor = ''
  do {
    const payload = await callApi(config, '/registrations', {
      query: { per_page: perPage, ...(cursor ? { cursor } : {}) },
      fetchImpl,
    })
    if (!Array.isArray(payload.result)) throw new Error('Cloudflare domain list response requires a result array')
    for (const row of payload.result) {
      const expires = isoDate(row?.expires_at)
      if (typeof row?.domain_name !== 'string' || !expires || typeof row.auto_renew !== 'boolean') {
        throw new Error('Cloudflare domain list returned incomplete or invalid registration facts; pending registrations may not have an expiry yet')
      }
      const domain = {
        name: normalizeName(row.domain_name),
        registrar: REGISTRAR,
        expires,
        autoRenew: row.auto_renew,
      }
      normalizeDomain(domain)
      domains.push(domain)
    }
    cursor = payload.result_info?.cursor
    if (typeof cursor !== 'string' || cursor.length > 256) throw new Error('Cloudflare returned an invalid registrations cursor')
    if (cursor && cursors.has(cursor)) throw new Error('Cloudflare repeated a registrations pagination cursor')
    if (cursor) cursors.add(cursor)
  } while (cursor)
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
  const accountId = await resolveAccountId(config)
  const payload = await rawCall(config, {
    path: '/zones',
    query: { name: normalized, 'account.id': accountId, match: 'all' },
    fetchImpl,
  })
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
    (zone.account?.id !== undefined && zone.account.id !== accountId) ||
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
