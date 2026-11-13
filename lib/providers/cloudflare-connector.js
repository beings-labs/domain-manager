import { HttpError, redact } from '../http.js'

export const CONNECTOR = '@beings-labs/dsh-cloudflare-connector'
const DEFAULT_TIMEOUT_MS = 120_000
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function getService(ctx) {
  return ctx?.get?.('cloudflareConnector')
}

export function isAvailable(ctx) {
  return typeof getService(ctx)?.request === 'function'
}

export function missingServerMessage() {
  return `The Cloudflare MCP connector service is not available. Install or update it with ` +
    `"dsh plugin --profile <profile> add ${CONNECTOR}@^0.1.1", restart DSH, and run ` +
    'cloudflare_connector_authorize with {"scopes":["registrar-domains.read"]} when no consent flow is pending. ' +
    'Approve Cloudflare\'s browser OAuth flow for registration reads; identity/account consent alone is insufficient. No API token is needed in MCP mode.'
}

export function asHttpError(error) {
  if (error instanceof HttpError) return error
  const message = redact(error?.message ?? String(error))
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null
  return new HttpError(message, {
    status,
    body: message,
    code: error?.code,
    scopes: error?.scopes,
    authorizationUrl: error?.authorizationUrl,
  })
}

export async function requestViaMcp(ctx, request, { accountId, timeoutMs = DEFAULT_TIMEOUT_MS, sensitiveValues = [] } = {}) {
  const service = getService(ctx)
  if (typeof service?.request !== 'function') throw new HttpError(missingServerMessage())
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive finite number')
  const account = accountId === undefined ? undefined : normalizeAccountId(accountId)
  if (accountId !== undefined && !account) throw new Error('Cloudflare accountId has an unexpected format')
  const secrets = [...sensitiveValues, ...(request?.sensitiveValues ?? [])].filter((value) => typeof value === 'string' && value.length)
  try {
    const { method, path, query, body } = request
    const value = await service.request({ method, path, query, body }, { accountId: account, timeoutMs, sensitiveValues: secrets })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cloudflare MCP request returned an unexpected API payload')
    return value
  } catch (error) {
    const failure = asHttpError(error)
    const hint = failure.code === 'invalid_scope'
      ? 'Cloudflare rejected an OAuth scope (invalid_scope). Check scopes_supported at https://mcp.cloudflare.com/.well-known/oauth-authorization-server and correct the requested scopes before calling cloudflare_connector_authorize again. Registrar reads use "registrar-domains.read", not "registrar:read"; availability/search and transfers can require "registrar-domains.admin". Reconnecting with the same invalid scope will not help.'
      : null
    throw new HttpError(redact(`${failure.message}${hint ? ` — ${hint}` : ''}`, secrets), {
      status: failure.status,
      url: failure.url,
      body: failure.body === null ? null : redact(String(failure.body), secrets),
      code: failure.code,
      scopes: failure.scopes,
      authorizationUrl: failure.authorizationUrl,
    })
  }
}

function normalizeAccountId(value) {
  return typeof value === 'string' && ACCOUNT_ID_RE.test(value.trim()) ? value.trim() : null
}

export async function discoverAccountId(ctx, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const payload = await requestViaMcp(ctx, { method: 'GET', path: '/accounts' }, { timeoutMs })
  const rows = Array.isArray(payload?.result) ? payload.result : null
  if (!rows) throw new Error('Cloudflare account discovery returned an unexpected payload; set cloudflare.accountId explicitly')
  if (rows.length === 0) throw new Error('The Cloudflare connection can see no accounts; authorize an account with cloudflare_connector_authorize')
  if (rows.length > 1) throw new Error(`The Cloudflare connection can see ${rows.length} accounts; set cloudflare.accountId (or CLOUDFLARE_ACCOUNT_ID) to choose one`)
  const id = normalizeAccountId(rows[0]?.id)
  if (!id) throw new Error('Cloudflare account discovery returned an invalid account id; set cloudflare.accountId explicitly')
  return id
}

export function createTransport(ctx, { getAccountId, onAccountId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let discovered = null
  let pending = null
  const knownAccountId = () => normalizeAccountId(getAccountId?.()) ?? discovered
  const resolveAccountId = async () => {
    const known = knownAccountId()
    if (known) return known
    if (!pending) {
      pending = discoverAccountId(ctx, { timeoutMs })
        .then((id) => {
          discovered = id
          onAccountId?.(id)
          return id
        })
        .finally(() => { pending = null })
    }
    return pending
  }
  return {
    request: (request) => requestViaMcp(ctx, request, {
      accountId: knownAccountId() ?? undefined,
      timeoutMs,
      sensitiveValues: request?.sensitiveValues ?? [],
    }),
    resolveAccountId,
    isAvailable: () => isAvailable(ctx),
    missingServerMessage,
  }
}
