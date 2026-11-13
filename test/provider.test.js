import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config, apply } from '../index.js'
import { fakeCloudflareConnector } from './support/cloudflare-connector.js'

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
async function harness({ config = {}, mcpTools = [], mcpResults = {}, cloudflareConnector } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-mcp-'))
  const registry = new Map()
  const calls = []
  for (const tool of mcpTools) registry.set(tool.name, tool)
  const tools = {
    register: (tool) => registry.set(tool.name, tool),
    schemas: () => [...registry.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    execute: async ({ calls: batch }) => ({
      results: await Promise.all(batch.map(async (call) => {
        calls.push(call)
        const handler = mcpResults[call.name]
        return {
          callId: call.id,
          result: typeof handler === 'function' ? await handler(call.arguments) : handler,
        }
      })),
    }),
  }
  const ctx = { tools, logger: { info() {}, warn() {} }, cloudflareConnector, get(name) { return this[name] } }
  await apply(
    ctx,
    { dataFile: join(dir, 'domains.json'), dueWithinDays: 90, currency: 'USD', namecheap: {}, cloudflare: {}, ...config },
  )
  return { dir, registry, calls, ctx }
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

test('providers.cloudflare=mcp explains how to connect the Cloudflare MCP server', async () => {
  const { registry } = await harness({ config: { providers: { cloudflare: 'mcp' } } })
  await assert.rejects(
    () => registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' }),
    /connector is missing.*@beings-labs\/dsh-cloudflare-connector/,
  )
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

/** Run with no ambient Cloudflare credentials, so provider selection is deterministic. */
async function withCleanCloudflareEnv(fn) {
  const keys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const CF_CONNECTED = {
  cloudflareConnector: fakeCloudflareConnector({
    routes: {
      'GET /accounts': { body: { success: true, result: [{ id: 'acct-mcp', name: 'Main' }] } },
      'GET /accounts/acct-mcp/registrar/registrations': {
        body: {
          success: true,
          result: [
            { domain_name: 'Example.COM', expires_at: '2027-03-15T12:00:00.000Z', auto_renew: true, status: 'active' },
          ],
          result_info: { cursor: '' },
        },
      },
      'POST /accounts/acct-mcp/registrar/domain-check': {
        body: {
          success: true,
          result: { domains: [{ name: 'example.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '8.57', renewal_cost: '8.57' } }] },
        },
      },
    },
  }).ctx.cloudflareConnector,
}

test('auto mode syncs Cloudflare through the MCP browser login when no API token exists', async () => {
  await withCleanCloudflareEnv(async () => {
    const { dir, registry } = await harness(CF_CONNECTED)
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('MCP mode must not call the REST API')
    }
    let synced
    try {
      synced = await registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' })
    } finally {
      globalThis.fetch = previousFetch
    }
    assert.equal(synced.added, 1)
    assert.match(synced.warnings[0], /registrations do not include renewal pricing/)

    const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
    assert.equal(data.domains[0].name, 'example.com')
    assert.equal(data.domains[0].registrar, 'Cloudflare')
    assert.equal(data.domains[0].expires, '2027-03-15')
    assert.equal(data.domains[0].renewalPrice, null)
    assert.equal(data.domains[0].source, 'cloudflare')
  })
})

test('explicit providers.cloudflare="mcp" syncs without any API credentials', async () => {
  await withCleanCloudflareEnv(async () => {
    const { registry } = await harness({ ...CF_CONNECTED, config: { providers: { cloudflare: 'mcp' } } })
    const synced = await registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' })
    assert.equal(synced.added, 1)
  })

  test('Cloudflare registration sync preserves stored prices and currency when the API has no pricing', async () => {
    await withCleanCloudflareEnv(async () => {
      const { dir, registry } = await harness(CF_CONNECTED)
      await registry.get('domain_manager_add').execute({
        name: 'example.com', registrar: 'Cloudflare', expires: '2026-03-15',
        renewalPrice: 22, promoPrice: 19, icannFee: 0.2, currency: 'EUR',
      })
      const synced = await registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' })
      assert.match(synced.warnings[0], /kept stored prices/)
      const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
      assert.equal(data.domains[0].expires, '2027-03-15')
      assert.equal(data.domains[0].renewalPrice, 22)
      assert.equal(data.domains[0].promoPrice, 19)
      assert.equal(data.domains[0].icannFee, 0.2)
      assert.equal(data.domains[0].currency, 'EUR')
    })
  })
})

test('explicit providers.cloudflare="api" reports the missing token instead of falling back', async () => {
  const { registry } = await harness({ ...CF_CONNECTED, config: { providers: { cloudflare: 'api' } } })
  await assert.rejects(
    () => registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' }),
    /Cloudflare API credentials are incomplete/,
  )
})

test('cloudflare auto mode keeps using a configured API token over a connected MCP server', async () => {
  const calls = []
  const { registry } = await harness({
    config: { cloudflare: { apiToken: 'api-token', accountId: 'acct' } },
    cloudflareConnector: {
      request: () => {
        throw new Error('MCP must not be used when API credentials are configured')
      },
    },
  })

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return {
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        result: [{ domain_name: 'api-example.com', expires_at: '2027-05-01T00:00:00.000Z', auto_renew: false, status: 'active' }],
        result_info: { cursor: '' },
      }),
    }
  }
  try {
    const synced = await registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' })
    assert.equal(synced.added, 1)
  } finally {
    globalThis.fetch = previousFetch
  }
  assert.match(calls[0], /api\.cloudflare\.com\/client\/v4\/accounts\/acct\/registrar\/registrations/)
})

test('availability pricing comes from the Cloudflare MCP connection', async () => {
  await withCleanCloudflareEnv(async () => {
    const { registry } = await harness(CF_CONNECTED)
    const value = await registry.get('domain_manager_check_availability').execute({ domains: 'example.dev' })
    assert.equal(value.provider, 'cloudflare')
    assert.equal(value.results[0].registrationPrice, '8.57')
  })
})

test('Cloudflare service can appear and disappear after startup without breaking other providers', async (t) => {
  await withCleanCloudflareEnv(async () => {
    const { registry, ctx, dir } = await harness({ config: { providers: { cloudflare: 'mcp' } } })
    t.after(() => rm(dir, { recursive: true, force: true }))
    await assert.rejects(registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' }), /connector is missing/)
    ctx.cloudflareConnector = CF_CONNECTED.cloudflareConnector
    const preview = await registry.get('domain_manager_sync').execute({ registrar: 'cloudflare', dryRun: true })
    assert.equal(preview.added, 1)
    assert.equal(preview.count, 0, 'a dry run does not mutate the portfolio')
    delete ctx.cloudflareConnector
    await assert.rejects(registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' }), /connector is missing/)
    assert.ok(registry.has('domain_manager_list'))
  })
})

test('auto mode rejects the startup API token without retrying or falling back to the connected OAuth service', async (t) => {
  await withCleanCloudflareEnv(async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'rejected-startup-token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
    let connectorRequests = 0
    const { registry, dir } = await harness({
      cloudflareConnector: { request: async () => { connectorRequests += 1; assert.fail('API rejection must not switch to OAuth') } },
    })
    t.after(() => rm(dir, { recursive: true, force: true }))
    await registry.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Cloudflare', expires: '2027-03-15', renewalPrice: 22 })
    const before = await readFile(join(dir, 'domains.json'), 'utf8')
    process.env.CLOUDFLARE_API_TOKEN = 'replacement-needs-restart'
    let apiRequests = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      apiRequests += 1
      assert.equal(init.headers.Authorization, 'Bearer rejected-startup-token')
      return { status: 401, text: async () => JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }) }
    }
    try {
      await assert.rejects(registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' }), (error) => {
        assert.equal(error.status, 401)
        assert.match(error.message, /API-token transport/)
        assert.match(error.message, /does not switch to OAuth after a failure/)
        assert.match(error.message, /restart the app/)
        assert.match(error.message, /providers.cloudflare to "mcp"/)
        assert.doesNotMatch(error.message, /invalid_scope|registrar:read|rejected-startup-token/)
        return true
      })
    } finally {
      globalThis.fetch = previousFetch
    }
    assert.equal(apiRequests, 1)
    assert.equal(connectorRequests, 0)
    assert.equal(await readFile(join(dir, 'domains.json'), 'utf8'), before, 'A failed sync must not mutate the portfolio')
  })
})

test('explicit MCP mode ignores a rejected environment API token and uses its separate OAuth grant', async (t) => {
  await withCleanCloudflareEnv(async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'rejected-api-token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-mcp'
    const { registry, dir } = await harness({ ...CF_CONNECTED, config: { providers: { cloudflare: 'mcp' } } })
    t.after(() => rm(dir, { recursive: true, force: true }))
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => { assert.fail('Explicit MCP mode must not use the API token') }
    try {
      const result = await registry.get('domain_manager_sync').execute({ registrar: 'cloudflare', dryRun: true })
      assert.equal(result.added, 1)
      assert.equal(result.dryRun, true)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

for (const code of ['invalid_scope', 'authorization_required', 'api_error']) {
  test(`Cloudflare sync preserves ${code} details and fails without changing the portfolio`, async (t) => {
    await withCleanCloudflareEnv(async () => {
      const scopes = code === 'invalid_scope' ? ['registrar:read'] : ['registrar-domains.admin']
      const authorizationUrl = code === 'authorization_required' ? 'https://mcp.cloudflare.com/authorize?state=public-flow-state' : undefined
      let requests = 0
      const { registry, dir } = await harness({
        config: { providers: { cloudflare: 'mcp' }, cloudflare: { accountId: 'acct' } },
        cloudflareConnector: {
          request: async () => {
            requests += 1
            const error = new Error(code === 'api_error' ? '10000 Authentication error' : `Cloudflare ${code}`)
            Object.assign(error, { status: code === 'invalid_scope' ? 400 : 403, code, scopes, authorizationUrl })
            throw error
          },
          authorize: async () => { assert.fail('Sync must not initiate consent') },
        },
      })
      t.after(() => rm(dir, { recursive: true, force: true }))
      await registry.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Cloudflare', expires: '2027-03-15' })
      const before = await readFile(join(dir, 'domains.json'), 'utf8')
      await assert.rejects(registry.get('domain_manager_sync').execute({ registrar: 'cloudflare' }), (error) => {
        assert.equal(error.code, code)
        assert.equal(error.status, code === 'invalid_scope' ? 400 : 403)
        assert.deepEqual(error.scopes, scopes)
        assert.equal(error.authorizationUrl, authorizationUrl)
        if (code === 'invalid_scope') assert.match(error.message, /Registrar reads use "registrar-domains.read", not "registrar:read"/)
        if (code === 'authorization_required') assert.doesNotMatch(error.message, /registrar-domains.read|No scope challenge/)
        if (code === 'api_error') assert.match(error.message, /Another identity-only sign-in may not fix this/)
        assert.doesNotMatch(error.message, /CLOUDFLARE_API_TOKEN/)
        return true
      })
      assert.equal(requests, 1)
      assert.equal(await readFile(join(dir, 'domains.json'), 'utf8'), before)
    })
  })
}
