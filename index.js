/**
 * dsh-domain-manager — model-facing tools for managing a domain portfolio.
 *
 * Generic on purpose: no bundled portfolio, no personal data, no registrar
 * credentials. Registrars are optional integrations configured by the user
 * (config or environment variables); the local portfolio store and RDAP
 * availability checks work with no credentials at all.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import {
  addDomain, daysLeft, emptyData, isTransferActive, loadData, normalizeName, removeDomain, round2, saveData,
  summarize, updateDomain, upsertDomain, writeFileAtomic,
} from './lib/store.js'
import { parseDomainsMarkdown, renderDomainsMarkdown } from './lib/markdown.js'
import { redact } from './lib/http.js'
import * as namecheap from './lib/registrars/namecheap.js'
import * as cloudflare from './lib/registrars/cloudflare.js'
import * as namecheapMcp from './lib/providers/mcp.js'
import { checkAvailability, checkViaRdap } from './lib/availability.js'
import { registerTransferTools, transferSchema, transferStateLabel } from './lib/transfers.js'

export const name = 'dsh-domain-manager'
export const inject = ['tools']

export const Config = Schema.object({
  dataFile: Schema.string().description('Absolute path of the portfolio JSON store. Defaults to $DSH_HOME/dsh-domain-manager/domains.json.'),
  dueWithinDays: Schema.number().default(90).description('Default expiry window used by reports and exports.'),
  staleAfterDays: Schema.number().default(14).description('Warn when registrar-synced domains have not been synced for more than this many days.'),
  currency: Schema.string().default('USD').description('Currency assumed for prices that do not carry one.'),
  namecheap: Schema.object({
    apiUser: Schema.string(),
    apiKey: Schema.string(),
    userName: Schema.string(),
    clientIp: Schema.string(),
    sandbox: Schema.boolean().default(false),
  }).description('Namecheap API credentials. Env fallback: NAMECHEAP_API_USER, NAMECHEAP_API_KEY, NAMECHEAP_USERNAME, NAMECHEAP_CLIENT_IP.'),
  cloudflare: Schema.object({
    apiToken: Schema.string(),
    accountId: Schema.string(),
    baseUrl: Schema.string(),
  }).description('Cloudflare API token + account id. Env fallback: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.'),
  providers: Schema.object({
    namecheap: Schema.string().default('auto'),
    cloudflare: Schema.string().default('auto'),
  }).description(
    'How each registrar is reached. Both default to "auto". Namecheap: "auto" (default; API credentials when configured, otherwise MCP), "api" (XML API credentials — the only mode that can read renewal, promo and ICANN prices for registered domains), or "mcp" (browser-login MCP connector; lists domains and checks availability but cannot read prices for registered domains). Cloudflare: "auto" (default; alias for api) or "api" (the plugin has no Cloudflare registrar MCP transport).',
  ),
})

const NAMECHEAP_MODES = ['api', 'mcp', 'auto']
const CLOUDFLARE_MODES = ['api', 'auto']

/**
 * Normalize the configured provider modes once, at startup.
 *
 * Both registrars default to `auto`: Namecheap prefers API credentials, then the
 * browser-login MCP connector. Cloudflare's `auto` is an alias for `api` because
 * the plugin has no Cloudflare registrar MCP transport.
 */
function resolveProviderPreferences(providers = {}) {
  const mode = (registrar, raw, allowed) => {
    const value = String(raw ?? 'auto').trim().toLowerCase()
    if (allowed.includes(value)) return value
    const error =
      registrar === 'cloudflare'
        ? 'Cloudflare registrar access is API-only in this plugin: there is no Cloudflare registrar MCP transport, so providers.cloudflare must be "api" or "auto" (default).'
        : 'providers.namecheap must be "api", "mcp" (browser login) or "auto" (default; API credentials when configured, otherwise MCP).'
    throw new Error(`${error} Got "${value}".`)
  }
  return {
    namecheap: mode('namecheap', providers.namecheap, NAMECHEAP_MODES),
    cloudflare: mode('cloudflare', providers.cloudflare, CLOUDFLARE_MODES),
  }
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) ?? undefined
}

/** Merge config credentials with environment fallbacks; environment never overrides explicit config. */
function resolveCredentials(config) {
  const namecheapConfig = {
    apiUser: firstNonEmpty(config.namecheap?.apiUser, process.env.NAMECHEAP_API_USER),
    apiKey: firstNonEmpty(config.namecheap?.apiKey, process.env.NAMECHEAP_API_KEY),
    userName: firstNonEmpty(config.namecheap?.userName, process.env.NAMECHEAP_USERNAME),
    clientIp: firstNonEmpty(config.namecheap?.clientIp, process.env.NAMECHEAP_CLIENT_IP),
    sandbox: Boolean(config.namecheap?.sandbox),
  }
  const cloudflareConfig = {
    apiToken: firstNonEmpty(config.cloudflare?.apiToken, process.env.CLOUDFLARE_API_TOKEN),
    accountId: firstNonEmpty(config.cloudflare?.accountId, process.env.CLOUDFLARE_ACCOUNT_ID),
    baseUrl: firstNonEmpty(config.cloudflare?.baseUrl),
  }
  return { namecheap: namecheapConfig, cloudflare: cloudflareConfig }
}

/** Serialize store mutations so two tool calls cannot interleave a read-modify-write. */
function createStoreQueue() {
  let queue = Promise.resolve()
  return function withStore(fn) {
    const run = queue.then(fn, fn)
    queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function money(value) {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : 'unknown'
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function fail(error) {
  throw new Error(redact(error?.message ?? String(error)))
}

// --- schemas shared by tools ---------------------------------------------

const domainSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    registrar: { type: 'string' },
    expires: { type: 'string' },
    autoRenew: { type: 'boolean' },
    renewalPrice: { type: 'number' },
    currency: { type: 'string' },
    promoPrice: { type: 'number' },
    icannFee: { type: 'number' },
    purpose: { type: 'string' },
    group: { type: 'string' },
    notes: { type: 'string' },
    daysLeft: { type: 'number' },
    daysSinceSync: { type: 'number' },
    transfer: transferSchema,
  },
}

const bucketSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { count: { type: 'number' }, annual: { type: 'number' } },
}

const reportSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asOf: { type: 'string' },
    count: { type: 'number' },
    unpriced: { type: 'number' },
    totalAnnual: { type: 'number' },
    totalAnnualAtPromo: { type: 'number' },
    icannFeesAnnual: { type: 'number' },
    totalAnnualWithFees: { type: 'number' },
    totalAnnualAtPromoWithFees: { type: 'number' },
    autoRenewOn: bucketSchema,
    autoRenewOff: bucketSchema,
    byRegistrar: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          registrar: { type: 'string' },
          count: { type: 'number' },
          annual: { type: 'number' },
          autoRenewAnnual: { type: 'number' },
          icannFeesAnnual: { type: 'number' },
          unpriced: { type: 'number' },
        },
      },
    },
    dueSoon: { type: 'array', items: domainSchema },
    expired: { type: 'array', items: domainSchema },
    dueWithinDays: { type: 'number' },
    staleness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staleAfterDays: { type: 'number' },
        syncedCount: { type: 'number' },
        neverSyncedCount: { type: 'number' },
        staleCount: { type: 'number' },
        oldestSyncedAt: { type: 'string' },
        newestSyncedAt: { type: 'string' },
        staleDomains: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              syncedAt: { type: 'string' },
              daysSinceSync: { type: 'number' },
            },
          },
        },
      },
    },
  },
}

const writeResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    name: { type: 'string' },
    count: { type: 'number' },
    totalAnnual: { type: 'number' },
  },
}

function toRow(domain) {
  const out = {
    name: domain.name,
    registrar: domain.registrar,
    expires: domain.expires,
    autoRenew: domain.autoRenew,
    currency: domain.currency,
  }
  if (typeof domain.renewalPrice === 'number') out.renewalPrice = domain.renewalPrice
  if (typeof domain.promoPrice === 'number') out.promoPrice = domain.promoPrice
  if (typeof domain.icannFee === 'number') out.icannFee = domain.icannFee
  if (domain.purpose) out.purpose = domain.purpose
  if (domain.group) out.group = domain.group
  if (domain.notes) out.notes = domain.notes
  if (typeof domain.daysLeft === 'number') out.daysLeft = domain.daysLeft
  if (typeof domain.daysSinceSync === 'number') out.daysSinceSync = domain.daysSinceSync
  if (domain.transfer) out.transfer = domain.transfer
  return out
}

function totalsOf(data) {
  return {
    count: data.domains.length,
    totalAnnual: round2(data.domains.reduce((total, domain) => total + (domain.renewalPrice ?? 0), 0)),
  }
}

function reportValue(data, dueWithinDays, staleAfterDays) {
  const summary = summarize(data, { dueWithinDays, staleAfterDays })
  return {
    asOf: summary.asOf,
    count: summary.count,
    unpriced: summary.unpriced,
    totalAnnual: summary.totalAnnual,
    totalAnnualAtPromo: summary.totalAnnualAtPromo,
    icannFeesAnnual: summary.icannFeesAnnual,
    totalAnnualWithFees: summary.totalAnnualWithFees,
    totalAnnualAtPromoWithFees: summary.totalAnnualAtPromoWithFees,
    autoRenewOn: { count: summary.autoRenew.on.count, annual: summary.autoRenew.on.annual },
    autoRenewOff: { count: summary.autoRenew.off.count, annual: summary.autoRenew.off.annual },
    byRegistrar: summary.byRegistrar,
    dueSoon: summary.dueSoon.map(toRow),
    expired: summary.expired.map(toRow),
    dueWithinDays: summary.dueWithinDays,
    staleness: {
      staleAfterDays: summary.staleness.staleAfterDays,
      syncedCount: summary.staleness.syncedCount,
      neverSyncedCount: summary.staleness.neverSyncedCount,
      staleCount: summary.staleness.staleCount,
      ...(summary.staleness.oldestSyncedAt === null ? {} : { oldestSyncedAt: summary.staleness.oldestSyncedAt }),
      ...(summary.staleness.newestSyncedAt === null ? {} : { newestSyncedAt: summary.staleness.newestSyncedAt }),
      staleDomains: summary.staleness.staleDomains,
    },
  }
}

function renderReport(value) {
  const lines = [
    `Domain portfolio as of ${value.asOf}: ${value.count} domains, ${money(value.totalAnnual)}/year total renewal cost` +
      (value.unpriced > 0 ? ` (${value.unpriced} without a recorded price)` : '') +
      (value.totalAnnualAtPromo === value.totalAnnual ? '' : ` — ${money(value.totalAnnualAtPromo)}/year at current promos`),
    '',
    'By registrar:',
  ]
  for (const entry of value.byRegistrar) {
    const fees = entry.icannFeesAnnual > 0 ? ` + ${money(entry.icannFeesAnnual)}/year ICANN fees` : ''
    lines.push(`- ${entry.registrar}: ${entry.count} domains, ${money(entry.annual)}/year (${money(entry.autoRenewAnnual)}/year auto-charged)${fees}`)
  }
  lines.push('')
  lines.push(`Auto-renew enabled: ${value.autoRenewOn.count} domains, ${money(value.autoRenewOn.annual)}/year charged without action.`)
  lines.push(`Auto-renew disabled: ${value.autoRenewOff.count} domains, ${money(value.autoRenewOff.annual)}/year needs manual renewal.`)
  if (value.icannFeesAnnual > 0) {
    lines.push(
      '',
      `ICANN fees (collected by the registrar): ${money(value.icannFeesAnnual)}/year — ${money(value.totalAnnualWithFees)}/year all-in` +
        (value.totalAnnualAtPromo === value.totalAnnual ? '' : ` (${money(value.totalAnnualAtPromoWithFees)}/year at current promos)`) +
        '.',
    )
  }
  if (value.dueSoon.length > 0) {
    lines.push('', `Expiring within ${value.dueWithinDays} days:`)
    for (const domain of value.dueSoon) {
      lines.push(`- ${domain.name} expires ${domain.expires} (${domain.daysLeft} days, auto-renew ${domain.autoRenew ? 'on' : 'off'}, ${money(domain.renewalPrice)})`)
    }
  }
  if (value.expired.length > 0) {
    lines.push('', 'Expired:')
    for (const domain of value.expired) lines.push(`- ${domain.name} expired ${domain.expires}`)
  }
  if (value.staleness && value.staleness.staleCount > 0) {
    lines.push(
      '',
      `Stale data: ${value.staleness.staleCount} of ${value.staleness.syncedCount} synced domains have not been synced for more than ` +
        `${value.staleness.staleAfterDays} days (oldest sync: ${value.staleness.oldestSyncedAt?.slice(0, 10) ?? 'unknown'}). ` +
        'Run domain_manager_sync to refresh expiry/auto-renew/price facts.',
    )
  }
  return lines.join('\n')
}

function renderAvailability(value) {
  const lines = [`Availability via ${value.provider}:`]
  for (const row of value.results) {
    const price = row.registrationPrice ?? row.renewalPrice
    const flags = [row.premium ? 'premium' : null, row.detail].filter(Boolean).join(', ')
    lines.push(
      `- ${row.name}: ${row.available ? 'available' : 'registered'}${price ? ` — ${price} ${row.currency ?? ''}`.trimEnd() : ''}${flags ? ` (${flags})` : ''}`,
    )
  }
  if (value.warnings?.length > 0) lines.push(`Warning: ${value.warnings.join('; ')}`)
  return lines.join('\n')
}

// --- plugin ---------------------------------------------------------------

export async function apply(ctx, config) {
  const dataFile = config.dataFile ?? join(dshHome(), 'dsh-domain-manager', 'domains.json')
  const withStore = createStoreQueue()
  const credentials = resolveCredentials(config)
  const dueWithinDays = config.dueWithinDays ?? 90
  const staleAfterDays = config.staleAfterDays ?? 14
  const providerPreferences = resolveProviderPreferences(config.providers ?? {})
  registerTransferTools(ctx, { dataFile, withStore, cloudflareConfig: credentials.cloudflare })

  /**
   * Which transport reaches Namecheap: api (API key — preferred in auto and the only
   * transport that can read renewal prices for registered domains), mcp (browser
   * login through a connected registrar MCP server; list/check only), or one of
   * the missing-* states.
   */
  function resolveNamecheapMode() {
    const schemas = typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : []
    const mcpReady = namecheapMcp.isAvailable(schemas)
    const apiReady = namecheap.isConfigured(credentials.namecheap)
    if (providerPreferences.namecheap === 'mcp') return mcpReady ? 'mcp' : 'missing-mcp'
    if (providerPreferences.namecheap === 'api') return apiReady ? 'api' : 'missing-api'
    // Auto: API credentials first, then the browser-login connector.
    return apiReady ? 'api' : mcpReady ? 'mcp' : 'none'
  }

  /**
   * Fetch Namecheap registrations plus, in API mode, the account's own renewal
   * pricing. Returns `{ rows, warnings }` so a pricing outage degrades to "kept
   * stored prices" instead of failing the whole sync.
   */
  async function fetchNamecheapDomains() {
    const mode = resolveNamecheapMode()
    if (mode === 'mcp') {
      // The MCP connector lists domains and checks availability only: it exposes no
      // renewal pricing for registered domains, so stored prices are kept and the
      // limitation is reported instead of silently surviving the sync.
      return {
        rows: await namecheapMcp.listDomains(ctx),
        warnings: [
          'Namecheap MCP mode cannot read renewal prices for registered domains (the MCP server exposes no pricing feed), so renewal, promo and ICANN prices were not refreshed; stored prices are kept unless the MCP payload itself carries a price. Configure Namecheap API credentials to refresh them from the pricing API in the default "auto" mode, or set providers.namecheap to "api" to require API access.',
        ],
      }
    }
    if (mode === 'api') {
      const rows = await namecheap.listDomains(credentials.namecheap)
      const warnings = []
      if (rows.length === 0) return { rows, warnings }
      try {
        // TLD-level rates from namecheap.users.getPricing; the API has no per-domain quote.
        const pricing = await namecheap.getRenewPricing(credentials.namecheap)
        for (const row of rows) {
          if (row.premium) {
            warnings.push(`${row.name}: premium registration — the TLD renewal rate may not apply, kept the stored price`)
            continue
          }
          const tld = namecheap.tldOf(row.name, pricing.keys())
          const quote = tld ? pricing.get(tld) : null
          if (!quote) {
            warnings.push(`${row.name}: no renewal price in the Namecheap pricing feed${tld ? ` for .${tld}` : ''}`)
            continue
          }
          row.renewalPrice = quote.renewalPrice
          row.promoPrice = quote.promoPrice
          row.icannFee = quote.icannFee
        }
      } catch (error) {
        warnings.push(redact(`Namecheap renewal pricing unavailable, kept stored prices: ${error.message}`))
      }
      return { rows, warnings }
    }
    throw new Error(
      mode === 'missing-api'
        ? 'Namecheap API credentials are incomplete: set apiUser, apiKey and clientIp (API is the only mode that can read renewal prices for registered domains). Alternatively use the default "auto" mode or set providers.namecheap to "mcp" and install dsh-namecheap-mcp for browser login — MCP mode lists domains but cannot read prices for registered domains.'
        : mode === 'missing-mcp'
          ? 'providers.namecheap is "mcp" but no Namecheap MCP server is connected: run "dsh plugin --profile <profile> add dsh-namecheap-mcp" (browser login), then restart. Note that MCP mode cannot read renewal prices for registered domains.'
          : 'Namecheap is not configured: set apiUser/apiKey/clientIp for the Namecheap API (preferred in the default "auto" mode, includes renewal prices), or install dsh-namecheap-mcp for browser login (domain list and availability only — no prices for registered domains).',
    )
  }

  /** Availability providers in priority order: Cloudflare, then Namecheap in its configured transport, then public RDAP. */
  function availabilityProviders() {
    const list = []
    if (cloudflare.isConfigured(credentials.cloudflare)) {
      list.push({ name: 'cloudflare', run: (names) => cloudflare.checkAvailability(credentials.cloudflare, names) })
    }
    const mode = resolveNamecheapMode()
    if (mode === 'mcp') {
      list.push({ name: 'namecheap-mcp', run: (names) => namecheapMcp.checkAvailability(ctx, names) })
    } else if (mode === 'api') {
      list.push({ name: 'namecheap', run: (names) => namecheap.checkAvailability(credentials.namecheap, names) })
    }
    list.push({
      name: 'rdap',
      run: async (names) => {
        const rows = []
        for (const name of names) rows.push(await checkViaRdap(name))
        return rows
      },
    })
    return list
  }

  await mkdir(dirname(dataFile), { recursive: true, mode: 0o700 })

  ctx.tools.register(defineTool({
    name: 'domain_manager_list',
    description: 'List domains in the local portfolio with registrar, expiry, auto-renew and renewal price. Optional filters: registrar, group, autoRenew, dueWithinDays.',
    parameters: {
      registrar: { type: 'string', description: 'Only this registrar, e.g. Cloudflare or Namecheap.' },
      group: { type: 'string', description: 'Only this group label.' },
      autoRenew: { type: 'boolean', description: 'Only domains with this auto-renew setting.' },
      dueWithinDays: { type: 'number', description: 'Only domains expiring within this many days.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          asOf: { type: 'string' },
          count: { type: 'number' },
          totalAnnual: { type: 'number' },
          domains: { type: 'array', items: domainSchema },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return text('No domains match.')
        const rows = value.domains.map((domain) => {
          const due = typeof domain.daysLeft === 'number' ? `, ${domain.daysLeft}d` : ''
          const fee = typeof domain.icannFee === 'number' ? ` + ${money(domain.icannFee)} ICANN` : ''
          const transfer = domain.transfer ? ` (transfer to ${domain.transfer.to}: ${transferStateLabel(domain.transfer)})` : ''
          return `| ${domain.name} | ${domain.registrar}${transfer} | ${domain.expires}${due} | auto-renew ${domain.autoRenew ? 'yes' : 'no'} | ${money(domain.renewalPrice)}/year${fee} |`
        })
        const fees = round2(value.domains.reduce((total, domain) => total + (domain.icannFee ?? 0), 0))
        return text(
          `${value.count} domains, ${money(value.totalAnnual)}/year total` +
            (fees > 0 ? ` (+${money(fees)}/year ICANN fees)` : '') +
            ` (${value.asOf})\n\n` +
            '| Domain | Registrar | Expires | Auto-renew | Renewal |\n|---|---|---|---|---|\n' +
            rows.join('\n'),
        )
      },
    },
    async execute(args) {
      try {
        return await withStore(async () => {
          const data = await loadData(dataFile)
          const today = new Date()
          let rows = data.domains.map((domain) => ({
            ...domain,
            daysLeft: daysLeft(domain.expires, today),
            ...(domain.syncedAt
              ? { daysSinceSync: Math.max(0, -daysLeft(domain.syncedAt.slice(0, 10), today)) }
              : {}),
          }))
          if (args.registrar) rows = rows.filter((domain) => domain.registrar.toLowerCase() === String(args.registrar).toLowerCase())
          if (args.group) rows = rows.filter((domain) => domain.group === args.group)
          if (typeof args.autoRenew === 'boolean') rows = rows.filter((domain) => domain.autoRenew === args.autoRenew)
          if (typeof args.dueWithinDays === 'number') {
            rows = rows.filter((domain) => domain.daysLeft >= 0 && domain.daysLeft <= args.dueWithinDays)
          }
          return {
            asOf: summarize(data).asOf,
            count: rows.length,
            totalAnnual: round2(rows.reduce((total, domain) => total + (domain.renewalPrice ?? 0), 0)),
            domains: rows.map(toRow),
          }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_report',
    description: 'Cost and expiry report: total yearly renewal cost, auto-renew on/off split, per-registrar subtotals, and domains expiring soon.',
    parameters: {
      dueWithinDays: { type: 'number', description: 'Expiry window. Defaults to the configured window.' },
    },
    output: {
      schema: reportSchema,
      render: (_args, value) => text(renderReport(value)),
    },
    async execute(args) {
      try {
        return await withStore(async () => {
          const data = await loadData(dataFile)
          return reportValue(
            data,
            typeof args.dueWithinDays === 'number' ? args.dueWithinDays : dueWithinDays,
            staleAfterDays,
          )
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_add',
    description: 'Add a domain to the local portfolio. Requires name, registrar and expires (YYYY-MM-DD); renewalPrice is optional.',
    parameters: {
      name: { type: 'string', required: true, description: 'Lowercase FQDN, e.g. example.com.' },
      registrar: { type: 'string', required: true, description: 'Registrar name, e.g. Cloudflare or Namecheap.' },
      expires: { type: 'string', required: true, description: 'Expiry date, YYYY-MM-DD.' },
      renewalPrice: { type: 'number', description: 'Yearly renewal price.' },
      autoRenew: { type: 'boolean', description: 'Whether the registrar renews it automatically.' },
      currency: { type: 'string', description: 'Currency code, default USD.' },
      promoPrice: { type: 'number', description: 'Current promotional price, if any.' },
      icannFee: { type: 'number', description: 'Per-year ICANN fee collected separately by the registrar.' },
      purpose: { type: 'string', description: 'What the domain is for.' },
      group: { type: 'string', description: 'Optional group label, e.g. brand or client-x.' },
      notes: { type: 'string', description: 'Free-form notes.' },
    },
    output: {
      schema: writeResultSchema,
      render: (_args, value) => text(`added ${value.name}; portfolio now ${value.count} domains, ${money(value.totalAnnual)}/year`),
    },
    async execute(args) {
      try {
        return await withStore(async () => {
          const data = await loadData(dataFile)
          const next = addDomain(data, { currency: config.currency ?? 'USD', source: 'manual', ...args })
          await saveData(dataFile, next)
          return { ok: true, name: normalizeName(args.name), ...totalsOf(next) }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_update',
    description: 'Update portfolio fields of an existing domain: expiry, price, auto-renew, registrar, purpose, group, promo price, notes.',
    parameters: {
      name: { type: 'string', required: true, description: 'Domain to update.' },
      registrar: { type: 'string', description: 'New registrar.' },
      expires: { type: 'string', description: 'New expiry date, YYYY-MM-DD.' },
      renewalPrice: { type: 'number', description: 'New yearly renewal price.' },
      autoRenew: { type: 'boolean', description: 'New auto-renew setting.' },
      currency: { type: 'string', description: 'New currency code.' },
      purpose: { type: 'string', description: 'New purpose (empty string clears it).' },
      group: { type: 'string', description: 'New group (empty string clears it).' },
      promoPrice: { type: 'number', description: 'New promo price (0 clears it).' },
      icannFee: { type: 'number', description: 'New per-year ICANN fee (0 means no fee).' },
      notes: { type: 'string', description: 'New notes (empty string clears them).' },
    },
    output: {
      schema: writeResultSchema,
      render: (_args, value) => text(`updated ${value.name}; portfolio now ${value.count} domains, ${money(value.totalAnnual)}/year`),
    },
    async execute(args) {
      try {
        return await withStore(async () => {
          const data = await loadData(dataFile)
          const { name: domainName, ...patch } = args
          const existing = data.domains.find((domain) => domain.name === normalizeName(domainName))
          if (patch.registrar && isTransferActive(existing?.transfer)) throw new Error('Cannot change registrar during a transfer; use domain_manager_transfer_status')
          if (patch.promoPrice === 0) patch.promoPrice = null
          const next = updateDomain(data, domainName, patch)
          await saveData(dataFile, next)
          return { ok: true, name: normalizeName(domainName), ...totalsOf(next) }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_remove',
    description: 'Remove a domain from the local portfolio (does not change anything at the registrar).',
    parameters: {
      name: { type: 'string', required: true, description: 'Domain to remove.' },
    },
    output: {
      schema: writeResultSchema,
      render: (_args, value) => text(`removed ${value.name}; portfolio now ${value.count} domains, ${money(value.totalAnnual)}/year`),
    },
    async execute(args) {
      try {
        return await withStore(async () => {
          const data = await loadData(dataFile)
          if (isTransferActive(data.domains.find((domain) => domain.name === normalizeName(args.name))?.transfer)) {
            throw new Error('Cannot remove a domain with an active or unknown transfer; check domain_manager_transfer_status first')
          }
          const next = removeDomain(data, args.name)
          await saveData(dataFile, next)
          return { ok: true, name: normalizeName(args.name), ...totalsOf(next) }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_sync',
    description:
      'Sync registrations from a registrar into the local portfolio (keeps local purpose/group/notes) and refresh registrar facts. Use dryRun to preview. Both registrars default to auto: Namecheap prefers configured API credentials, otherwise uses MCP browser login. Namecheap API mode also refreshes renewal, promo and ICANN-fee prices, while MCP mode lists domains only and cannot read prices for registered domains. Cloudflare is API-only.',
    parameters: {
      registrar: { type: 'string', required: true, description: 'namecheap, cloudflare, or all.' },
      dryRun: { type: 'boolean', description: 'Report changes without saving.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          added: { type: 'number' },
          updated: { type: 'number' },
          unchanged: { type: 'number' },
          missing: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          totalAnnual: { type: 'number' },
        },
      },
      render: (_args, value) =>
        text(
          `${value.dryRun ? 'dry run: ' : ''}sync finished — ${value.added} added, ${value.updated} updated, ${value.unchanged} unchanged` +
            (value.missing.length > 0 ? `; in store but not returned by the registrar: ${value.missing.join(', ')}` : '') +
            (value.warnings.length > 0 ? `\nwarning: ${value.warnings.join('; ')}` : '') +
            `\nportfolio now ${value.count} domains, ${money(value.totalAnnual)}/year`,
        ),
    },
    async execute(args) {
      try {
        const target = String(args.registrar).toLowerCase()
        if (!['namecheap', 'cloudflare', 'all'].includes(target)) throw new Error('registrar must be namecheap, cloudflare, or all')
        const providers = target === 'all' ? ['namecheap', 'cloudflare'] : [target]
        const fetched = []
        const fetchedCount = new Map()
        const fetchWarnings = []
        for (const provider of providers) {
          let rows
          if (provider === 'namecheap') {
            const result = await fetchNamecheapDomains()
            rows = result.rows
            fetchWarnings.push(...result.warnings)
          } else {
            rows = await cloudflare.listDomains(credentials.cloudflare)
          }
          fetchedCount.set(provider, rows.length)
          fetched.push(...rows)
        }
        return await withStore(async () => {
          const data = await loadData(dataFile)
          const now = new Date().toISOString()
          let next = data
          let added = 0
          let updated = 0
          let unchanged = 0
          const transferWarnings = []
          const seen = new Set()
          const seenByRegistrar = new Set()
          for (const row of fetched) {
            const registrarKey = `${row.registrar}:${row.name}`
            if (seenByRegistrar.has(registrarKey)) throw new Error(`registrar sync returned a duplicate domain: ${row.name}`)
            seenByRegistrar.add(registrarKey)
            const existing = data.domains.find((domain) => domain.name === row.name)
            const transfer = existing?.transfer
            if (
              (isTransferActive(transfer) && row.registrar === transfer.to) ||
              (transfer?.state === 'succeeded' && row.registrar === transfer.from)
            ) {
              unchanged += 1
              transferWarnings.push(`${row.name}: ignored ${row.registrar} facts to avoid changing registrar before verified transfer completion or reverting a completed transfer; use domain_manager_transfer_status`)
              continue
            }
            if (seen.has(row.name)) throw new Error(`registrar sync returned a duplicate domain: ${row.name}`)
            seen.add(row.name)
            const changingRegistrar = existing && existing.registrar !== row.registrar
            const merged = {
              ...row,
              renewalPrice: row.renewalPrice ?? (changingRegistrar ? null : existing?.renewalPrice) ?? null,
              promoPrice: Object.hasOwn(row, 'promoPrice') ? row.promoPrice : (changingRegistrar ? null : existing?.promoPrice ?? null),
              icannFee: Object.hasOwn(row, 'icannFee') ? row.icannFee : (changingRegistrar ? null : existing?.icannFee ?? null),
              currency: row.currency ?? existing?.currency ?? config.currency ?? 'USD',
              source: row.registrar.toLowerCase(),
              syncedAt: now,
            }
            const changed =
              !existing ||
              existing.expires !== merged.expires ||
              existing.autoRenew !== merged.autoRenew ||
              existing.registrar !== merged.registrar ||
              existing.renewalPrice !== merged.renewalPrice ||
              existing.promoPrice !== merged.promoPrice ||
              existing.icannFee !== merged.icannFee ||
              existing.currency !== merged.currency
            next = upsertDomain(next, merged)
            if (!existing) added += 1
            else if (changed) updated += 1
            else unchanged += 1
          }
          const missing = data.domains
            .filter((domain) => providers.some((provider) => domain.registrar.toLowerCase() === provider) && !seen.has(domain.name))
            .map((domain) => domain.name)
          // A registrar integration that answers with zero rows must not look like a
          // clean sync: without this, a broken adapter silently skips every domain.
          const warnings = [...fetchWarnings, ...transferWarnings]
          for (const provider of providers) {
            if ((fetchedCount.get(provider) ?? 0) > 0) continue
            const stored = data.domains.filter((domain) => domain.registrar.toLowerCase() === provider)
            if (stored.length === 0) continue
            warnings.push(
              `${provider} returned 0 domains, so none of its ${stored.length} local ${stored.length === 1 ? 'entry was' : 'entries were'} refreshed — check that the registrar integration is connected and reachable`,
            )
          }
          if (!args.dryRun) await saveData(dataFile, next)
          const result = { ...totalsOf(args.dryRun ? data : next) }
          return {
            ok: true,
            dryRun: Boolean(args.dryRun),
            added,
            updated,
            unchanged,
            missing,
            warnings,
            count: result.count,
            totalAnnual: result.totalAnnual,
          }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_check_availability',
    description: 'Check whether domains are available to register (1-20 names). Uses the configured Cloudflare or Namecheap API when available for pricing, otherwise public RDAP.',
    parameters: {
      domains: { type: 'string', required: true, description: 'Comma- or space-separated domain names.' },
      provider: { type: 'string', description: 'auto (default), cloudflare, namecheap, mcp (Namecheap browser login; requires providers.namecheap "mcp" or "auto"), or rdap.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                available: { type: 'boolean' },
                status: { type: 'string' },
                premium: { type: 'boolean' },
                registrationPrice: { type: 'string' },
                renewalPrice: { type: 'string' },
                premiumPrice: { type: 'string' },
                currency: { type: 'string' },
                source: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => text(renderAvailability(value)),
    },
    async execute(args) {
      try {
        const explicit = String(args.provider ?? 'auto').toLowerCase()
        const ncMode = resolveNamecheapMode()
        const registry = { cloudflare: 'cloudflare', namecheap: ncMode === 'mcp' ? 'namecheap-mcp' : 'namecheap', mcp: 'namecheap-mcp', rdap: 'rdap' }
        let providers = availabilityProviders()
        if (explicit !== 'auto') {
          const wanted = registry[explicit]
          if (!wanted) throw new Error(`provider must be auto, mcp, cloudflare, namecheap, or rdap (got ${explicit})`)
          providers = providers.filter((provider) => provider.name === wanted)
          if (providers.length === 0) {
            const mcpConnected = namecheapMcp.isAvailable(typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : [])
            throw new Error(
              explicit === 'mcp'
                ? mcpConnected
                  ? 'the Namecheap MCP server is connected but providers.namecheap is not "mcp", so it is not used: set providers.namecheap to "mcp" to enable browser-login mode.'
                  : 'the Namecheap MCP server is not connected: run "dsh plugin --profile <profile> add dsh-namecheap-mcp" for browser login, or use provider=namecheap with API credentials'
                : `${explicit} is not configured (check the plugin config or credentials)`,
            )
          }
        }
        const value = await checkAvailability(args.domains, { providers })
        return {
          provider: value.provider,
          warnings: value.warnings,
          results: value.results.map((row) => {
            const out = { name: row.name, available: Boolean(row.available), source: row.source ?? value.provider }
            if (row.status) out.status = row.status
            if (typeof row.premium === 'boolean') out.premium = row.premium
            if (row.registrationPrice !== null && row.registrationPrice !== undefined) out.registrationPrice = String(row.registrationPrice)
            if (row.renewalPrice !== null && row.renewalPrice !== undefined) out.renewalPrice = String(row.renewalPrice)
            if (row.premiumPrice !== null && row.premiumPrice !== undefined) out.premiumPrice = String(row.premiumPrice)
            if (row.currency) out.currency = row.currency
            if (row.detail) out.detail = row.detail
            return out
          }),
        }
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_search',
    description: 'Search for domain name candidates by keyword using the Cloudflare Registrar search API (requires Cloudflare credentials). Results are for discovery only — confirm with domain_manager_check_availability before acting.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword or phrase, e.g. "coffee shop".' },
      limit: { type: 'number', description: 'Number of candidates, 1-20 (default 5).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                available: { type: 'boolean' },
                premium: { type: 'boolean' },
                registrationPrice: { type: 'string' },
                renewalPrice: { type: 'string' },
                currency: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.results.length === 0) return text(`no candidates for "${value.query}"`)
        return text(
          `candidates for "${value.query}":\n` +
            value.results
              .map((row) => `- ${row.name}: ${row.available ? 'available' : 'taken'}${row.registrationPrice ? ` — ${row.registrationPrice} ${row.currency}` : ''}`)
              .join('\n'),
        )
      },
    },
    async execute(args) {
      try {
        const rows = await cloudflare.searchDomains(credentials.cloudflare, args.query, { limit: args.limit ?? 5 })
        return {
          query: args.query,
          results: rows.map((row) => {
            const out = { name: row.name, available: Boolean(row.available), premium: Boolean(row.premium) }
            if (row.registrationPrice !== null && row.registrationPrice !== undefined) out.registrationPrice = String(row.registrationPrice)
            if (row.renewalPrice !== null && row.renewalPrice !== undefined) out.renewalPrice = String(row.renewalPrice)
            if (row.currency) out.currency = row.currency
            return out
          }),
        }
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_import_markdown',
    description: 'Import domains from a markdown document that contains portfolio tables (Domain / Expires / optional Renewal Price, Auto-renew, Purpose, Group, Notes, Registrar). Replaces the store when replace=true, otherwise upserts.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the markdown file.' },
      replace: { type: 'boolean', description: 'Replace the whole portfolio instead of upserting.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          imported: { type: 'number' },
          added: { type: 'number' },
          updated: { type: 'number' },
          skipped: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          totalAnnual: { type: 'number' },
        },
      },
      render: (_args, value) =>
        text(
          `imported ${value.imported} domains (${value.added} added, ${value.updated} updated)` +
            (value.skipped.length > 0 ? `; skipped ${value.skipped.length} table(s)/row(s)` : '') +
            `\nportfolio now ${value.count} domains, ${money(value.totalAnnual)}/year`,
        ),
    },
    async execute(args) {
      try {
        const markdown = await readFile(args.path, 'utf8')
        const parsed = parseDomainsMarkdown(markdown)
        if (parsed.domains.length === 0) throw new Error(`no portfolio tables found in ${args.path}`)
        return await withStore(async () => {
          const stored = await loadData(dataFile)
          if (args.replace && stored.domains.some((domain) => isTransferActive(domain.transfer))) {
            throw new Error('Cannot replace the portfolio while transfers are active or unknown; check domain_manager_transfer_status first')
          }
          const current = args.replace ? emptyData() : stored
          let next = current
          let added = 0
          let updated = 0
          for (const domain of parsed.domains) {
            const existing = next.domains.find((entry) => entry.name === domain.name)
            if (isTransferActive(existing?.transfer) && existing.registrar.toLowerCase() !== domain.registrar.toLowerCase()) {
              throw new Error(`Cannot change registrar for ${domain.name} during a transfer; use domain_manager_transfer_status`)
            }
            next = upsertDomain(next, domain)
            if (existing) updated += 1
            else added += 1
          }
          const saved = await saveData(dataFile, next)
          return {
            ok: true,
            imported: parsed.domains.length,
            added,
            updated,
            skipped: parsed.skipped,
            ...totalsOf(saved),
          }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'domain_manager_export_markdown',
    description: 'Render the portfolio to a markdown document grouped by registrar with totals and an auto-renew split. Use dryRun to preview without writing.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute output path, e.g. /home/me/domains.md.' },
      dryRun: { type: 'boolean', description: 'Return the markdown instead of writing it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          bytes: { type: 'number' },
          count: { type: 'number' },
          markdown: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok ? `wrote ${value.count} domains to ${value.path} (${value.bytes} bytes)` : value.markdown),
    },
    async execute(args) {
      try {
        return await withStore(async () => {
          const data = await loadData(dataFile)
          const markdown = renderDomainsMarkdown(data, { dueWithinDays, staleAfterDays })
          if (args.dryRun) return { ok: false, path: args.path, bytes: 0, count: data.domains.length, markdown }
          await writeFileAtomic(args.path, markdown)
          return { ok: true, path: args.path, bytes: Buffer.byteLength(markdown), count: data.domains.length, markdown: '' }
        })
      } catch (error) {
        fail(error)
      }
    },
  }))

  const namecheapModeNote = providerPreferences.namecheap === 'mcp' ? ' (MCP cannot read registered-domain prices)' : ''
  ctx.logger?.info?.(
    `dsh-domain-manager ready (store: ${dataFile}; namecheap: ${providerPreferences.namecheap} mode${namecheapModeNote}, API ${namecheap.isConfigured(credentials.namecheap) ? 'configured' : 'not configured'}; cloudflare: ${providerPreferences.cloudflare} mode (API-only), API ${cloudflare.isConfigured(credentials.cloudflare) ? 'configured' : 'not configured'})`,
  )
}
