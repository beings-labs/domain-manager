import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config, apply } from '../index.js'

const NC_LIST_TOOL = { name: 'mcp__namecheap__domains_list', parameters: { type: 'object', properties: {} } }
const NC_CHECK_TOOL = {
  name: 'mcp__namecheap__domains_check_availability',
  parameters: { type: 'object', properties: { domains: { type: 'array' } } },
}

const NC_LIST_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain Name="example.com" Expires="03/15/2027" AutoRenew="true" IsPremium="false" />
    </DomainGetListResult>
    <Paging><TotalItems>1</TotalItems><PageSize>100</PageSize></Paging>
  </CommandResponse>
</ApiResponse>`

const NC_PRICING_XML = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.users.getPricing">
    <UserGetPricingResult>
      <ProductType Name="domains">
        <ProductCategory Name="renew">
          <Product Name="com">
            <Price Duration="1" DurationType="YEAR" Price="10.00" RegularPrice="12.00" AdditionalCost="0.20" />
          </Product>
        </ProductCategory>
      </ProductType>
    </UserGetPricingResult>
  </CommandResponse>
</ApiResponse>`

/**
 * Build a plugin instance whose tool registry already contains fake registrar MCP
 * tools, so provider selection can be exercised without a real OAuth session.
 */
async function harness({ config = {}, mcpTools = [], mcpResults = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-mcp-'))
  const registry = new Map()
  const calls = []
  for (const tool of mcpTools) registry.set(tool.name, tool)
  const tools = {
    register: (tool) => registry.set(tool.name, tool),
    schemas: () => [...registry.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    execute: async ({ calls: batch }) => ({
      results: batch.map((call) => {
        calls.push(call)
        const handler = mcpResults[call.name]
        return {
          callId: call.id,
          result: typeof handler === 'function' ? handler(call.arguments) : handler,
        }
      }),
    }),
  }
  await apply(
    { tools, logger: { info() {}, warn() {} } },
    { dataFile: join(dir, 'domains.json'), dueWithinDays: 90, currency: 'USD', namecheap: {}, cloudflare: {}, ...config },
  )
  return { dir, registry, calls }
}

/** Route fetch to the Namecheap XML fixtures used by the API-mode tests. */
function stubNamecheapApi(urls) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return {
      status: 200,
      text: async () => (String(url).includes('getPricing') ? NC_PRICING_XML : NC_LIST_XML),
    }
  }
  return () => {
    globalThis.fetch = previousFetch
  }
}

test('both registrar provider modes default to auto', () => {
  assert.equal(Config.shape.providers.shape.namecheap.value, 'auto')
  assert.equal(Config.shape.providers.shape.cloudflare.value, 'auto')
})

test('default auto mode syncs Namecheap through the API and ignores a connected MCP server when credentials are configured', async () => {
  const urls = []
  const { dir, registry, calls } = await harness({
    config: { namecheap: { apiUser: 'default-api', apiKey: 'k', clientIp: '1.2.3.4' } },
    mcpTools: [NC_LIST_TOOL],
    mcpResults: {
      'mcp__namecheap__domains_list': () => {
        throw new Error('MCP must not be used when API credentials are configured')
      },
    },
  })

  const restore = stubNamecheapApi(urls)
  try {
    const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap' })
    assert.equal(synced.added, 1)
    assert.deepEqual(synced.warnings, [])
    assert.ok(urls.some((url) => url.includes('Command=namecheap.domains.getList')))
    assert.ok(urls.some((url) => url.includes('Command=namecheap.users.getPricing')))
    assert.equal(calls.length, 0, 'default auto mode prefers configured API credentials over MCP')

    const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
    assert.equal(data.domains[0].registrar, 'Namecheap')
    assert.equal(data.domains[0].source, 'namecheap')
    assert.equal(data.domains[0].renewalPrice, 12)
    assert.equal(data.domains[0].promoPrice, 10)
    assert.equal(data.domains[0].icannFee, 0.2)
    assert.match(data.domains[0].syncedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    restore()
  }
})

test('explicit API mode without credentials explains both paths and the MCP pricing gap', async () => {
  const { registry } = await harness({ config: { providers: { namecheap: 'api' } }, mcpTools: [NC_LIST_TOOL] })
  await assert.rejects(
    () => registry.get('domain_manager_sync').execute({ registrar: 'namecheap' }),
    /Namecheap API credentials are incomplete[\s\S]*dsh-namecheap-mcp[\s\S]*cannot read prices for registered domains/,
  )
})

for (const [label, config] of [
  ['omitted providers', {}],
  ['empty providers', { providers: {} }],
  ['omitted Namecheap mode', { providers: { cloudflare: 'api' } }],
  ['explicit auto', { providers: { namecheap: 'auto' } }],
]) {
  test(`Namecheap falls back to MCP without API credentials (${label})`, async () => {
    const { registry, calls } = await harness({
      config,
      mcpTools: [NC_LIST_TOOL],
      mcpResults: {
        'mcp__namecheap__domains_list': { value: { domains: [{ name: 'auto.example', expires: '2027-03-15' }] } },
      },
    })

    const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap' })
    assert.equal(synced.added, 1)
    assert.equal(calls[0].name, 'mcp__namecheap__domains_list')
  })
}

test('default auto mode without API credentials or MCP reports setup guidance', async () => {
  const { registry } = await harness()
  await assert.rejects(
    () => registry.get('domain_manager_sync').execute({ registrar: 'namecheap' }),
    /Namecheap is not configured[\s\S]*apiUser\/apiKey\/clientIp[\s\S]*dsh-namecheap-mcp/,
  )
})

test('explicit providers.namecheap=auto prefers API credentials over a connected MCP server', async () => {
  const urls = []
  const { registry, calls } = await harness({
    config: {
      namecheap: { apiUser: 'auto-api', apiKey: 'k', clientIp: '1.2.3.4' },
      providers: { namecheap: 'auto' },
    },
    mcpTools: [NC_LIST_TOOL],
    mcpResults: {
      'mcp__namecheap__domains_list': () => {
        throw new Error('MCP must not be used when API credentials are configured')
      },
    },
  })

  const restore = stubNamecheapApi(urls)
  try {
    const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap' })
    assert.equal(synced.added, 1)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('providers.namecheap=mcp warns that registered-domain prices cannot be read and keeps stored prices', async () => {
  const { dir, registry } = await harness({
    config: { providers: { namecheap: 'mcp' } },
    mcpTools: [NC_LIST_TOOL],
    mcpResults: {
      'mcp__namecheap__domains_list': {
        value: { domains: [{ name: 'example.com', expires: '2027-03-15', autoRenew: true }] },
      },
    },
  })

  await registry.get('domain_manager_add').execute({
    name: 'example.com', registrar: 'Namecheap', expires: '2026-01-01', renewalPrice: 7.5, promoPrice: 6,
  })
  // Seed an ICANN fee (domain_manager_add does not expose the field; syncs normally write it).
  const file = join(dir, 'domains.json')
  const seeded = JSON.parse(await readFile(file, 'utf8'))
  seeded.domains[0].icannFee = 0.2
  await writeFile(file, JSON.stringify(seeded), 'utf8')

  const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap' })
  assert.equal(synced.updated, 1)
  assert.equal(synced.warnings.length, 1)
  assert.match(synced.warnings[0], /cannot read renewal prices for registered domains/)

  const data = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(data.domains[0].renewalPrice, 7.5, 'MCP mode keeps the stored renewal price')
  assert.equal(data.domains[0].promoPrice, 6, 'MCP mode keeps the stored promo price')
  assert.equal(data.domains[0].icannFee, 0.2, 'MCP mode keeps the stored ICANN fee')
})

test('providers.namecheap=mcp fails with install guidance when no MCP server is connected', async () => {
  const { registry } = await harness({ config: { providers: { namecheap: 'mcp' } } })
  await assert.rejects(() => registry.get('domain_manager_sync').execute({ registrar: 'namecheap' }), /dsh-namecheap-mcp/)
  await assert.rejects(
    () => registry.get('domain_manager_check_availability').execute({ domains: 'example.com', provider: 'mcp' }),
    /dsh-namecheap-mcp/,
  )
})

test('providers.namecheap=mcp wins over configured API credentials', async () => {
  const { registry } = await harness({
    config: {
      namecheap: { apiUser: 'u', apiKey: 'k', clientIp: '1.2.3.4' },
      providers: { namecheap: 'mcp' },
    },
    mcpTools: [NC_LIST_TOOL],
    mcpResults: { 'mcp__namecheap__domains_list': { value: { domains: [{ name: 'mcp.example', expires: '2027-01-01' }] } } },
  })
  const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap' })
  assert.equal(synced.count, 1)
})

for (const [label, config] of [
  ['default auto', {}],
  ['explicit MCP', { providers: { namecheap: 'mcp' } }],
]) {
  test(`availability uses the Namecheap MCP provider without API credentials (${label})`, async () => {
    const { registry, calls } = await harness({
      config,
      mcpTools: [NC_CHECK_TOOL],
      mcpResults: {
        'mcp__namecheap__domains_check_availability': {
          value: { domains: [{ name: 'example.dev', available: true, premium: false, registrationPrice: '8.57', currency: 'USD' }] },
        },
      },
    })
    const value = await registry.get('domain_manager_check_availability').execute({ domains: 'example.dev' })
    assert.equal(value.provider, 'namecheap-mcp')
    assert.equal(value.results[0].available, true)
    assert.equal(value.results[0].registrationPrice, '8.57')
    assert.deepEqual(calls[0].arguments, { domains: ['example.dev'] })
  })
}

test('availability in explicit API mode does not silently use a connected MCP server', async () => {
  const { registry, calls } = await harness({
    config: { providers: { namecheap: 'api' } },
    mcpTools: [NC_CHECK_TOOL],
    mcpResults: {
      'mcp__namecheap__domains_check_availability': {
        value: { domains: [{ name: 'example.dev', available: false }] },
      },
    },
  })

  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 404, text: async () => '' })
  try {
    const value = await registry.get('domain_manager_check_availability').execute({ domains: 'example.dev' })
    assert.equal(value.provider, 'rdap')
    assert.equal(value.results[0].available, true)
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('provider=mcp explains when the server is connected but MCP mode is not enabled', async () => {
  const { registry } = await harness({
    config: { providers: { namecheap: 'api' } },
    mcpTools: [NC_CHECK_TOOL],
    mcpResults: { 'mcp__namecheap__domains_check_availability': { value: { domains: [] } } },
  })
  await assert.rejects(
    () => registry.get('domain_manager_check_availability').execute({ domains: 'example.dev', provider: 'mcp' }),
    /providers\.namecheap is not "mcp"/,
  )
})

test('availability falls back to RDAP when no MCP server and no credentials exist', async () => {
  const { registry } = await harness()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 404, text: async () => '' })
  try {
    const value = await registry.get('domain_manager_check_availability').execute({ domains: 'example.dev' })
    assert.equal(value.provider, 'rdap')
    assert.equal(value.results[0].available, true)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('invalid providers.namecheap value is rejected at startup', async () => {
  await assert.rejects(() => harness({ config: { providers: { namecheap: 'browser' } } }), /providers\.namecheap must be "api"/)
})

test('providers.cloudflare=mcp is rejected because Cloudflare registrar access is API-only', async () => {
  await assert.rejects(() => harness({ config: { providers: { cloudflare: 'mcp' } } }), /Cloudflare registrar access is API-only/)
})

test('sync reads the canonical MCP value envelope the bridge returns', async () => {
  // Regression: the MCP bridge hands back { content, structuredContent? } as result.value.
  // The adapter used to unwrap to that envelope, find no rows, and report a clean 0-row sync.
  const { registry, dir } = await harness({
    config: { providers: { namecheap: 'mcp' } },
    mcpTools: [NC_LIST_TOOL],
    mcpResults: {
      'mcp__namecheap__domains_list': {
        value: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                items: [{ name: 'beings.agency', expirationDate: '2027-03-15T00:00:00.000Z', autoRenew: true }],
                total: 1,
              }),
            },
          ],
        },
      },
    },
  })

  const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap' })
  assert.equal(synced.added, 1)
  assert.equal(synced.warnings.length, 1)
  assert.match(synced.warnings[0], /cannot read renewal prices for registered domains/)

  const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
  assert.equal(data.domains[0].name, 'beings.agency')
  assert.equal(data.domains[0].autoRenew, true)
  assert.equal(data.domains[0].source, 'namecheap')
  assert.match(data.domains[0].syncedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('sync warns when a registrar integration returns zero rows instead of silently no-oping', async () => {
  const { registry } = await harness({
    config: { providers: { namecheap: 'mcp' } },
    mcpTools: [NC_LIST_TOOL],
    mcpResults: {
      'mcp__namecheap__domains_list': { value: { content: [{ type: 'text', text: JSON.stringify({ items: [], total: 0 }) }] } },
    },
  })
  await registry.get('domain_manager_add').execute({ name: 'beings.agency', registrar: 'Namecheap', expires: '2027-03-15' })

  const synced = await registry.get('domain_manager_sync').execute({ registrar: 'namecheap', dryRun: true })
  assert.equal(synced.unchanged, 0)
  assert.deepEqual(synced.missing, ['beings.agency'])
  assert.equal(synced.warnings.length, 2)
  assert.ok(synced.warnings.some((warning) => /namecheap returned 0 domains/.test(warning)))
  assert.ok(synced.warnings.some((warning) => /cannot read renewal prices for registered domains/.test(warning)))
})

test('availability renders fallback warnings when MCP returns incomplete data', async () => {
  const { registry } = await harness({
    mcpTools: [NC_CHECK_TOOL],
    mcpResults: { 'mcp__namecheap__domains_check_availability': { value: { domains: [] } } },
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 404, text: async () => '' })
  try {
    const value = await registry.get('domain_manager_check_availability').execute({ domains: 'example.com' })
    assert.equal(value.provider, 'rdap')
    assert.equal(value.results.length, 1)
    assert.equal(value.warnings.length, 1)
    assert.match(value.warnings[0], /omitted domains/)
    const rendered = registry.get('domain_manager_check_availability').output.render({}, value)[0].text
    assert.match(rendered, /Warning: namecheap-mcp:/)
  } finally {
    globalThis.fetch = previousFetch
  }
})
