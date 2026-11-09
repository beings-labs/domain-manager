import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

const CF_PAGE = {
  success: true,
  result: [
    {
      name: 'example.com', expires_at: '2027-03-15T12:00:00.000Z', auto_renew: true,
      premium_type: 'not_premium', fees: { renewal_fee: 9.15, currency: 'USD' },
    },
  ],
  result_info: { page: 1, per_page: 100, total_pages: 1 },
}

async function harness(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-plugin-'))
  const tools = new Map()
  const logs = []
  const config = {
    dataFile: join(dir, 'domains.json'),
    dueWithinDays: 90,
    currency: 'USD',
    namecheap: {},
    cloudflare: {},
    ...overrides,
  }
  await apply(
    { tools: { register: (tool) => tools.set(tool.name, tool) }, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
    config,
  )
  return { dir, tools, logs, config }
}

test('registers the full tool set without any personal data', async () => {
  const { tools, logs } = await harness()
  assert.deepEqual([...tools.keys()].sort(), [
    'domain_manager_add', 'domain_manager_check_availability', 'domain_manager_export_markdown',
    'domain_manager_import_markdown', 'domain_manager_list', 'domain_manager_remove', 'domain_manager_report',
    'domain_manager_search', 'domain_manager_sync', 'domain_manager_update',
  ])
  assert.ok(logs.some((line) => line.includes('dsh-domain-manager ready')))
  assert.ok(logs.some((line) => line.includes('namecheap: auto mode') && line.includes('cloudflare: auto mode')))
})

test('starts with an empty portfolio', async () => {
  const { tools } = await harness()
  const report = await tools.get('domain_manager_report').execute({})
  assert.equal(report.count, 0)
  assert.equal(report.totalAnnual, 0)
  const list = await tools.get('domain_manager_list').execute({})
  assert.equal(list.count, 0)
})

test('add, list, report, update, remove stay consistent', async () => {
  const { tools } = await harness()
  const add = tools.get('domain_manager_add')
  assert.deepEqual(
    await add.execute({ name: 'Example.COM', registrar: 'Cloudflare', expires: '2027-03-15', renewalPrice: 9.15, autoRenew: true }),
    { ok: true, name: 'example.com', count: 1, totalAnnual: 9.15 },
  )
  await add.execute({ name: 'example.dev', registrar: 'Namecheap', expires: '2027-04-01', renewalPrice: 12, autoRenew: false, purpose: 'test' })

  const report = await tools.get('domain_manager_report').execute({})
  assert.equal(report.count, 2)
  assert.equal(report.totalAnnual, 21.15)
  assert.deepEqual(report.autoRenewOn, { count: 1, annual: 9.15 })
  assert.deepEqual(report.autoRenewOff, { count: 1, annual: 12 })
  assert.match(tools.get('domain_manager_report').output.render({}, report)[0].text, /2 domains, \$21\.15\/year/)

  const filtered = await tools.get('domain_manager_list').execute({ registrar: 'namecheap' })
  assert.equal(filtered.count, 1)
  assert.equal(filtered.domains[0].name, 'example.dev')

  const updated = await tools.get('domain_manager_update').execute({ name: 'example.dev', autoRenew: true, renewalPrice: 14 })
  assert.deepEqual(updated, { ok: true, name: 'example.dev', count: 2, totalAnnual: 23.15 })

  const removed = await tools.get('domain_manager_remove').execute({ name: 'example.dev' })
  assert.deepEqual(removed, { ok: true, name: 'example.dev', count: 1, totalAnnual: 9.15 })
  await assert.rejects(() => tools.get('domain_manager_remove').execute({ name: 'example.dev' }), /unknown domain/)
})

test('markdown export/import round-trips without personal data', async () => {
  const { dir, tools } = await harness()
  await tools.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Cloudflare', expires: '2027-03-15', renewalPrice: 9.15, autoRenew: true, purpose: 'demo' })
  const path = join(dir, 'portfolio.md')
  const written = await tools.get('domain_manager_export_markdown').execute({ path })
  assert.equal(written.ok, true)
  const markdown = await readFile(path, 'utf8')
  assert.match(markdown, /## Cloudflare \(1 domains\)/)
  assert.match(markdown, /example\.com/)

  const dry = await tools.get('domain_manager_export_markdown').execute({ path: join(dir, 'dry.md'), dryRun: true })
  assert.equal(dry.ok, false)
  assert.match(dry.markdown, /Total annual renewal cost/)

  const imported = await tools.get('domain_manager_import_markdown').execute({ path, replace: true })
  assert.equal(imported.imported, 1)
  assert.equal(imported.count, 1)
})

test('domain_manager_sync imports Cloudflare registrations and keeps local curation', async () => {
  const { dir, tools } = await harness({ cloudflare: { apiToken: 'test-token', accountId: 'acct' } })
  const previousFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { status: 200, text: async () => JSON.stringify(CF_PAGE) }
  }
  try {
    // pre-existing local curation for the same domain
    await tools.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Cloudflare', expires: '2026-01-01', renewalPrice: 1, purpose: 'kept locally', group: 'demo' })

    const dry = await tools.get('domain_manager_sync').execute({ registrar: 'cloudflare', dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.updated, 1)

    const synced = await tools.get('domain_manager_sync').execute({ registrar: 'cloudflare' })
    assert.equal(synced.added, 0)
    assert.equal(synced.updated, 1)
    assert.equal(synced.count, 1, 'dry run must not double count')

    const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
    const domain = data.domains[0]
    assert.equal(domain.expires, '2027-03-15')
    assert.equal(domain.autoRenew, true)
    assert.equal(domain.renewalPrice, 9.15)
    assert.equal(domain.purpose, 'kept locally')
    assert.equal(domain.group, 'demo')
    assert.equal(domain.source, 'cloudflare')
    assert.match(urls[0], /api\.cloudflare\.com\/client\/v4\/accounts\/acct\/registrar\/domains/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('domain_manager_sync without credentials explains how to configure it', async () => {
  const { tools } = await harness()
  await assert.rejects(() => tools.get('domain_manager_sync').execute({ registrar: 'cloudflare' }), /Cloudflare API is not configured/)
  await assert.rejects(() => tools.get('domain_manager_sync').execute({ registrar: 'namecheap' }), /Namecheap is not configured/)
  await assert.rejects(() => tools.get('domain_manager_sync').execute({ registrar: 'godaddy' }), /registrar must be/)
})

test('availability falls back to RDAP without registrar credentials', async () => {
  const { tools } = await harness()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('rdap.org')) return { status: 404, text: async () => '' }
    throw new Error(`unexpected url ${url}`)
  }
  try {
    const value = await tools.get('domain_manager_check_availability').execute({ domains: 'example.dev' })
    assert.equal(value.provider, 'rdap')
    assert.equal(value.results[0].available, true)
    assert.match(tools.get('domain_manager_check_availability').output.render({}, value)[0].text, /example\.dev: available/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('availability prefers Cloudflare pricing when configured', async () => {
  const { tools } = await harness({ cloudflare: { apiToken: 't', accountId: 'acct' } })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        success: true,
        result: {
          domains: [
            { name: 'example.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '8.57', renewal_cost: '8.57' } },
          ],
        },
      }),
  })
  try {
    const value = await tools.get('domain_manager_check_availability').execute({ domains: 'example.dev' })
    assert.equal(value.provider, 'cloudflare')
    assert.equal(value.results[0].registrationPrice, '8.57')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('domain_manager_search requires Cloudflare credentials', async () => {
  const { tools } = await harness()
  await assert.rejects(() => tools.get('domain_manager_search').execute({ query: 'acme' }), /Cloudflare API is not configured/)
})

test('report warns when synced data is stale, and stays quiet for manual domains', async () => {
  const { dir, tools } = await harness()
  await tools.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Cloudflare', expires: '2027-03-15', renewalPrice: 10, autoRenew: true })

  // manual-only portfolio: no synced timestamps, so no stale warning
  const manual = await tools.get('domain_manager_report').execute({})
  assert.equal(manual.staleness.staleCount, 0)
  assert.equal(manual.staleness.neverSyncedCount, 1)
  assert.doesNotMatch(tools.get('domain_manager_report').output.render({}, manual)[0].text, /Stale data/)

  // pretend a registrar sync wrote this domain a year ago
  const file = join(dir, 'domains.json')
  const data = JSON.parse(await readFile(file, 'utf8'))
  data.domains[0].syncedAt = '2025-11-08T00:00:00Z'
  data.domains[0].source = 'cloudflare'
  await writeFile(file, JSON.stringify(data), 'utf8')

  const report = await tools.get('domain_manager_report').execute({})
  assert.equal(report.staleness.staleCount, 1)
  assert.equal(report.staleness.syncedCount, 1)
  assert.equal(report.staleness.oldestSyncedAt, '2025-11-08T00:00:00Z')
  assert.match(
    tools.get('domain_manager_report').output.render({}, report)[0].text,
    /Stale data: 1 of 1 synced domains have not been synced for more than 14 days/,
  )

  // synced recently again: warning clears
  const fresh = JSON.parse(await readFile(file, 'utf8'))
  fresh.domains[0].syncedAt = new Date().toISOString()
  await writeFile(file, JSON.stringify(fresh), 'utf8')
  const clean = await tools.get('domain_manager_report').execute({})
  assert.equal(clean.staleness.staleCount, 0)
  assert.doesNotMatch(tools.get('domain_manager_report').output.render({}, clean)[0].text, /Stale data/)
})

test('export marks stale data', async () => {
  const { dir, tools } = await harness()
  await tools.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Cloudflare', expires: '2027-03-15', renewalPrice: 10 })
  const file = join(dir, 'domains.json')
  const data = JSON.parse(await readFile(file, 'utf8'))
  data.domains[0].syncedAt = '2025-01-01T00:00:00Z'
  await writeFile(file, JSON.stringify(data), 'utf8')
  const path = join(dir, 'stale.md')
  await tools.get('domain_manager_export_markdown').execute({ path })
  const markdown = await readFile(path, 'utf8')
  assert.match(markdown, /Data may be stale: 1 domain\(s\) not synced in more than 14 days/)
})

test('no bundled personal data: seed file is gone and an empty store is created', async () => {
  const { dir } = await harness()
  const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8').catch(() => '{"domains":[]}'))
  assert.deepEqual(data.domains ?? [], [])
  await assert.rejects(() => readFile(new URL('../seed/domains.json', import.meta.url), 'utf8'), /ENOENT/)
})

test('import rejects documents with no portfolio tables', async () => {
  const { dir, tools } = await harness()
  const path = join(dir, 'empty.md')
  await writeFile(path, '# nothing\n', 'utf8')
  await assert.rejects(() => tools.get('domain_manager_import_markdown').execute({ path }), /no portfolio tables/)
})

const NC_LIST = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain Name="example.com" Expires="03/15/2027" AutoRenew="true" IsPremium="false" />
    </DomainGetListResult>
    <Paging><TotalItems>1</TotalItems><PageSize>100</PageSize></Paging>
  </CommandResponse>
</ApiResponse>`

const NC_PRICING = `<?xml version="1.0"?>
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

const NC_ERROR = `<?xml version="1.0"?>
<ApiResponse Status="ERROR">
  <Errors><Error Number="1011102">API Key is invalid</Error></Errors>
</ApiResponse>`

test('domain_manager_sync fills Namecheap renewal price, promo and ICANN fee from the pricing API', async () => {
  const { dir, tools } = await harness({ namecheap: { apiUser: 'sync-price', apiKey: 'k', clientIp: '1.2.3.4' } })
  const previousFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return String(url).includes('getPricing')
      ? { status: 200, text: async () => NC_PRICING }
      : { status: 200, text: async () => NC_LIST }
  }
  try {
    await tools.get('domain_manager_add').execute({
      name: 'example.com', registrar: 'Namecheap', expires: '2026-01-01', renewalPrice: 1, autoRenew: false, purpose: 'kept locally',
    })

    const synced = await tools.get('domain_manager_sync').execute({ registrar: 'namecheap' })
    assert.equal(synced.warnings.length, 0)
    assert.equal(synced.updated, 1)
    assert.ok(urls.some((url) => url.includes('Command=namecheap.users.getPricing')))

    const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
    const domain = data.domains.find((entry) => entry.name === 'example.com')
    assert.equal(domain.renewalPrice, 12)
    assert.equal(domain.promoPrice, 10)
    assert.equal(domain.icannFee, 0.2)
    assert.equal(domain.purpose, 'kept locally')

    const report = await tools.get('domain_manager_report').execute({})
    assert.equal(report.icannFeesAnnual, 0.2)
    assert.equal(report.totalAnnualWithFees, 12.2)
    assert.equal(report.totalAnnualAtPromoWithFees, 10.2)
    const rendered = tools.get('domain_manager_report').output.render({}, report)[0].text
    assert.match(rendered, /ICANN fees \(collected by the registrar\): \$0\.20\/year — \$12\.20\/year all-in/)
    assert.match(rendered, /at current promos/)

    const listText = tools.get('domain_manager_list').output.render({}, await tools.get('domain_manager_list').execute({}))[0].text
    assert.match(listText, /\$12\.00\/year \+ \$0\.20 ICANN/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('domain_manager_sync keeps stored Namecheap prices when the pricing feed is unavailable', async () => {
  const { dir, tools } = await harness({ namecheap: { apiUser: 'sync-broken-price', apiKey: 'k', clientIp: '1.2.3.4' } })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) =>
    String(url).includes('getPricing')
      ? { status: 200, text: async () => NC_ERROR }
      : { status: 200, text: async () => NC_LIST }
  try {
    await tools.get('domain_manager_add').execute({ name: 'example.com', registrar: 'Namecheap', expires: '2026-01-01', renewalPrice: 1, autoRenew: false })
    const synced = await tools.get('domain_manager_sync').execute({ registrar: 'namecheap' })
    assert.equal(synced.warnings.length, 1)
    assert.match(synced.warnings[0], /pricing unavailable, kept stored prices/)

    const data = JSON.parse(await readFile(join(dir, 'domains.json'), 'utf8'))
    const domain = data.domains.find((entry) => entry.name === 'example.com')
    assert.equal(domain.renewalPrice, 1, 'stored price survives a pricing outage')
    assert.equal(domain.icannFee, null)
    assert.equal(domain.expires, '2027-03-15', 'registration facts still refresh')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('ICANN fees round-trip through add, update, export and replace import', async (t) => {
  const { dir, tools } = await harness()
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(tools.get('domain_manager_add').parameters.icannFee.type, 'number')
  assert.equal(tools.get('domain_manager_update').parameters.icannFee.type, 'number')
  await tools.get('domain_manager_add').execute({
    name: 'example.com', registrar: 'Namecheap', expires: '2027-03-15', renewalPrice: 12, icannFee: 0.2,
  })
  await tools.get('domain_manager_update').execute({ name: 'example.com', icannFee: 0.3 })
  const path = join(dir, 'portfolio.md')
  await tools.get('domain_manager_export_markdown').execute({ path })
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  await tools.get('domain_manager_import_markdown').execute({ path, replace: true })
  const report = await tools.get('domain_manager_report').execute({})
  assert.equal(report.icannFeesAnnual, 0.3)
  assert.equal(report.totalAnnualWithFees, 12.3)
})

test('concurrent store mutations remain serialized and failed mutations do not poison the queue', async (t) => {
  const { dir, tools } = await harness()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(() => tools.get('domain_manager_remove').execute({ name: 'missing.com' }), /unknown domain/)
  const added = await Promise.all(Array.from({ length: 8 }, (_, index) => tools.get('domain_manager_add').execute({
    name: `example${index}.com`, registrar: 'Cloudflare', expires: '2027-03-15', renewalPrice: 10,
  })))
  assert.deepEqual(added.map((result) => result.count), [1, 2, 3, 4, 5, 6, 7, 8])
  const report = await tools.get('domain_manager_report').execute({})
  assert.equal(report.count, 8)
  assert.equal(report.totalAnnual, 80)
})

test('startup surfaces inaccessible store directories instead of silently continuing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-startup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'not-a-directory')
  await writeFile(file, 'kept', 'utf8')
  await assert.rejects(() => apply({ tools: { register() {} } }, {
    dataFile: join(file, 'domains.json'),
  }), /ENOTDIR|EEXIST/)
})

test('duplicate registrar rows refuse a sync without changing the saved store', async (t) => {
  const { dir, tools } = await harness({ cloudflare: { apiToken: 't', accountId: 'acct' } })
  t.after(() => rm(dir, { recursive: true, force: true }))
  await tools.get('domain_manager_add').execute({
    name: 'example.com', registrar: 'Cloudflare', expires: '2026-01-01', renewalPrice: 1,
  })
  const file = join(dir, 'domains.json')
  const before = await readFile(file, 'utf8')
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ ...CF_PAGE, result: [CF_PAGE.result[0], CF_PAGE.result[0]] }),
  })
  try {
    await assert.rejects(() => tools.get('domain_manager_sync').execute({ registrar: 'cloudflare' }), /duplicate domain/)
    assert.equal(await readFile(file, 'utf8'), before)
  } finally {
    globalThis.fetch = previousFetch
  }
})
