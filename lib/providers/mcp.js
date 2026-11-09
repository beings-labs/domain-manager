/**
 * Adapter for registrar MCP servers registered by the host's MCP client.
 *
 * DSH's MCP client exposes every tool of a connected server as
 * `mcp__<serverName>__<toolName>`. Namecheap's official MCP server (bridged by
 * the `dsh-namecheap-mcp` connector, browser OAuth, no API key) publishes
 * `domains_list` and `domains_check_availability`, so this module lets the
 * plugin use those tools instead of API credentials.
 *
 * Pricing caveat: that MCP server exposes no renewal pricing for registered
 * domains (no per-domain quote and no pricing feed), so the default `auto` mode
 * prefers configured API credentials. MCP mode lists domains and
 * checks availability only and keeps whatever prices are already in the store.
 *
 * Everything here is defensive: MCP servers control their own tool names,
 * argument names and result shapes, so we introspect the registered schema for
 * argument names and accept either a canonical value or text content.
 *
 * No cordis imports: `ctx` is duck-typed (tools.schemas / tools.execute), which
 * keeps the module unit-testable.
 */

import { randomUUID } from 'node:crypto'
import { normalizeDomain } from '../store.js'

const DEFAULT_SERVER = 'namecheap'
const CALL_TIMEOUT_MS = 180_000

const NAME_KEYS = ['name', 'domain', 'domainName', 'domain_name', 'fqdn']
const DATE_KEYS = ['expires', 'expiresAt', 'expires_at', 'expiry', 'expiration', 'expirationDate', 'expiration_date', 'renewalDate']
const AUTO_KEYS = ['autoRenew', 'auto_renew', 'autoRenewal', 'autoRenewEnabled', 'renewsAutomatically']
const PRICE_KEYS = ['renewalPrice', 'renewalFee', 'renewal_fee', 'price', 'amount']
const CURRENCY_KEYS = ['currency', 'currencyCode', 'currency_code']
const AVAILABLE_KEYS = ['available', 'registrable', 'isAvailable', 'is_available', 'availableForRegistration']
const PREMIUM_KEYS = ['premium', 'isPremium', 'is_premium']
const REG_PRICE_KEYS = ['registrationPrice', 'registrationFee', 'registration_cost', 'price']
const PREMIUM_PRICE_KEYS = ['premiumPrice', 'premium_price']

const ARG_CANDIDATES = {
  domains: ['domains', 'domainList', 'domain_list', 'domainNames', 'domain_names', 'names'],
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function pick(record, keys) {
  if (record === null || typeof record !== 'object') return undefined
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  // case-insensitive fallback
  const lower = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]))
  for (const key of keys) {
    const value = lower.get(key.toLowerCase())
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

export function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/)
    if (match) return Number(match[0])
  }
  return null
}

export function toBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', 'on', 'enabled', 'active', '1'].includes(normalized)) return true
    if (['false', 'no', 'off', 'disabled', 'inactive', '0'].includes(normalized)) return false
  }
  return undefined
}

export function toIsoDate(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  const text = String(value).trim()
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) return `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`
  const named = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{4})$/)
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase())
    if (month >= 0) return `${named[3]}-${String(month + 1).padStart(2, '0')}-${String(named[2]).padStart(2, '0')}`
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function toolName(server, name) {
  return `mcp__${server}__${name}`
}

/** Find one registered MCP tool schema, or null when the server is not connected. */
export function findTool(schemas, name, { server = DEFAULT_SERVER } = {}) {
  const wanted = toolName(server, name)
  return (schemas ?? []).find((schema) => schema?.name === wanted) ?? null
}

/** Whether the registrar's MCP server is connected (it may expose list and/or check only). */
export function isAvailable(schemas, { server = DEFAULT_SERVER } = {}) {
  return Boolean(findTool(schemas, 'domains_list', { server }) ?? findTool(schemas, 'domains_check_availability', { server }))
}

/**
 * Map logical arguments onto the tool's declared parameter names.
 * Falls back to the logical name when the schema declares no properties.
 */
export function buildArgs(tool, values) {
  const properties = tool?.parameters?.properties ?? {}
  const keys = Object.keys(properties)
  const args = {}
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) continue
    const key = (ARG_CANDIDATES[field] ?? [field]).find((candidate) => keys.includes(candidate)) ?? field
    args[key] = value
  }
  return args
}

function contentText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Extract the useful payload from a normalized tool result: the canonical value
 * when the tool declares one, otherwise structured content, otherwise parsed
 * JSON text, otherwise the raw text.
 */
function maybeParse(text) {
  if (typeof text !== 'string') return text
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

/**
 * Keys that wrap the registrar rows in a payload.
 */
const ROW_KEYS = ['domains', 'items', 'results', 'data', 'list', 'records']

function hasRowWrapper(value) {
  return Array.isArray(value) || (value !== null && typeof value === 'object' && ROW_KEYS.some((key) => Array.isArray(value[key])))
}

/**
 * Decode a result-shaped object (`{ content, structuredContent? }`) into the payload
 * the registrar adapters understand, preferring whichever candidate carries rows.
 */
function decodeContent(source) {
  const structured = source.structuredContent
  const text = contentText(source)
  const parsed = text.length > 0 ? maybeParse(text) : undefined
  if (hasRowWrapper(structured)) return structured
  if (parsed !== undefined && hasRowWrapper(parsed)) return parsed
  if (parsed !== undefined && typeof parsed !== 'string') return parsed
  if (structured !== undefined && structured !== null) return structured
  return text.length > 0 ? (parsed ?? text) : source
}

export function unwrapResult(result) {
  let value = maybeParse(result)
  const seen = new Set()
  while (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new Error('cyclic MCP result envelope')
    seen.add(value)
    if (value.isError) throw new Error(`MCP tool error: ${contentText(value) || 'unknown error'}`)
    if (value.value !== undefined && value.value !== null) {
      value = maybeParse(value.value)
      continue
    }
    const decoded = decodeContent(value)
    if (decoded === value) return value
    value = decoded
  }
  if (value === null || value === undefined) throw new Error('MCP tool returned no result')
  return value
}

/** Call one MCP tool through the registry and return its unwrapped payload. */
export async function callTool(ctx, name, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!ctx?.tools || typeof ctx.tools.execute !== 'function') throw new Error('tool registry is unavailable; cannot call MCP tools')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive finite number')
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`MCP tool ${name} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const batch = await Promise.race([
      ctx.tools.execute({
        calls: [{ id: `dsh-domain-manager-mcp-${randomUUID()}`, name, arguments: args }],
        signal: controller.signal,
      }),
      timeout,
    ])
    const result = batch?.results?.[0]?.result
    if (!result) throw new Error(`MCP tool ${name} returned no result (is the server connected?)`)
    return unwrapResult(result)
  } finally {
    clearTimeout(timer)
  }
}

/** MCP payloads may be a bare array or an object wrapping one under a common key. */
export function asRows(value) {
  const payload = unwrapResult(value)
  if (Array.isArray(payload)) return payload
  if (payload !== null && typeof payload === 'object') {
    for (const key of ROW_KEYS) if (Array.isArray(payload[key])) return payload[key]
  }
  throw new Error('MCP payload must contain a domain array')
}

/** Normalize an MCP registrar row into the plugin's domain shape. */
export function normalizeDomainRow(row, { registrar = 'Namecheap' } = {}) {
  if (row === null || typeof row !== 'object') return null
  const name = String(pick(row, NAME_KEYS) ?? '').toLowerCase().trim()
  const expires = toIsoDate(pick(row, DATE_KEYS))
  if (!name || !expires) return null
  const autoRenew = pick(row, AUTO_KEYS)
  if (autoRenew !== undefined && toBool(autoRenew) === undefined) throw new Error('MCP domains_list returned an invalid auto-renew setting')
  const normalized = {
    name,
    registrar,
    expires,
    autoRenew: toBool(autoRenew) ?? false,
    premium: toBool(pick(row, PREMIUM_KEYS)) ?? false,
    renewalPrice: toNumber(pick(row, PRICE_KEYS)),
    currency: String(pick(row, CURRENCY_KEYS) ?? 'USD').toUpperCase(),
  }
  normalizeDomain(normalized)
  return normalized
}

/** Normalize an MCP availability row into the plugin's availability shape. */
export function normalizeAvailabilityRow(row, { source = 'namecheap-mcp' } = {}) {
  if (row === null || typeof row !== 'object') return null
  const name = String(pick(row, NAME_KEYS) ?? '').toLowerCase().trim()
  const available = toBool(pick(row, AVAILABLE_KEYS))
  if (!name || available === undefined) return null
  return {
    name,
    available,
    premium: toBool(pick(row, PREMIUM_KEYS)) ?? false,
    registrationPrice: toNumber(pick(row, REG_PRICE_KEYS)),
    renewalPrice: toNumber(pick(row, PRICE_KEYS)),
    premiumPrice: toNumber(pick(row, PREMIUM_PRICE_KEYS)),
    currency: String(pick(row, CURRENCY_KEYS) ?? 'USD').toUpperCase(),
    source,
    detail: null,
  }
}

/** List domains through the registrar MCP server. */
export async function listDomains(ctx, { server = DEFAULT_SERVER } = {}) {
  const schemas = typeof ctx?.tools?.schemas === 'function' ? ctx.tools.schemas() : []
  const tool = findTool(schemas, 'domains_list', { server })
  if (!tool) {
    throw new Error(
      `the ${server} MCP server is not connected (no ${toolName(server, 'domains_list')} tool). ` +
        'Install the registrar MCP connector — for Namecheap: dsh plugin add dsh-namecheap-mcp (browser login, no API key) — or configure API credentials instead.',
    )
  }
  const value = await callTool(ctx, tool.name, buildArgs(tool, {}))
  return asRows(value).map((row, index) => {
    const normalized = normalizeDomainRow(row)
    if (!normalized) throw new Error(`MCP domains_list returned an invalid row at index ${index}`)
    return normalized
  })
}

/** Check availability through the registrar MCP server. */
export async function checkAvailability(ctx, names, { server = DEFAULT_SERVER } = {}) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('checkAvailability needs at least one domain')
  const schemas = typeof ctx?.tools?.schemas === 'function' ? ctx.tools.schemas() : []
  const tool = findTool(schemas, 'domains_check_availability', { server })
  if (!tool) {
    throw new Error(
      `the ${server} MCP server is not connected (no ${toolName(server, 'domains_check_availability')} tool). ` +
        'Install the registrar MCP connector — for Namecheap: dsh plugin add dsh-namecheap-mcp — or configure API credentials instead.',
    )
  }
  const value = await callTool(ctx, tool.name, buildArgs(tool, { domains: names }))
  return asRows(value).map((row, index) => {
    const normalized = normalizeAvailabilityRow(row)
    if (!normalized) throw new Error(`MCP availability returned an invalid row at index ${index}`)
    return normalized
  })
}
