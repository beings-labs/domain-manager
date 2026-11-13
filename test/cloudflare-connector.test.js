import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import * as cloudflare from '../lib/registrars/cloudflare.js'
import * as mcp from '../lib/providers/cloudflare-connector.js'
import { HttpError } from '../lib/http.js'
import { fakeCloudflareConnector } from './support/cloudflare-connector.js'

const LIST_ROUTES = {
  'GET /accounts/acct/registrar/registrations': ({ query }) => {
    const rows = !query.cursor
      ? [{ domain_name: 'example.com', expires_at: '2027-03-15T12:00:00.000Z', auto_renew: true, status: 'active' }]
      : [{ domain_name: 'example.dev', expires_at: '2027-04-01T00:00:00.000Z', auto_renew: false, status: 'active' }]
    return { body: { success: true, result: rows, result_info: { cursor: query.cursor ? '' : 'next' } } }
  },
}

function transportConfig(ctx, { accountId = 'acct', ...rest } = {}) {
  return { ...rest, accountId, transport: (request) => mcp.requestViaMcp(ctx, request, { accountId }) }
}

test('the published connector release is an optional peer and setup guidance uses its compatible range', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.peerDependencies[mcp.CONNECTOR], '^0.1.1')
  assert.equal(pkg.peerDependenciesMeta[mcp.CONNECTOR].optional, true)
  assert.ok(mcp.missingServerMessage().includes(`add ${mcp.CONNECTOR}@${pkg.peerDependencies[mcp.CONNECTOR]}`))
  assert.equal(pkg.dependencies?.[mcp.CONNECTOR], undefined, 'API-only users must not need a connector installation')
})

test('detects the connector service independently of model-facing tools', () => {
  const { ctx } = fakeCloudflareConnector()
  assert.equal(mcp.isAvailable(ctx), true)
  assert.equal(mcp.isAvailable({}), false)
  assert.equal(mcp.isAvailable({ tools: { schemas: () => [{ name: 'mcp__cloudflare_connector__execute' }] } }), false)
  assert.match(mcp.missingServerMessage(), /@beings-labs\/dsh-cloudflare-connector/)
  assert.match(mcp.missingServerMessage(), /OAuth/)
})

test('requests use the service without generating JavaScript in domain-manager', async () => {
  const { ctx, requests } = fakeCloudflareConnector({
    routes: { 'GET /zones': { body: { success: true, result: [] } }, 'POST /accounts/acct/registrar/domain-check': { body: { success: true, result: { domains: [] } } } },
  })
  await mcp.requestViaMcp(ctx, { method: 'GET', path: '/zones', query: { name: 'example.com', 'account.id': 'acct' } })
  await mcp.requestViaMcp(ctx, { method: 'POST', path: '/accounts/acct/registrar/domain-check', body: { domains: ['a"b\\c\n.com'] } })
  assert.deepEqual(requests[0], { method: 'GET', path: '/zones', query: { name: 'example.com', 'account.id': 'acct' }, body: undefined })
  assert.deepEqual(requests[1], { method: 'POST', path: '/accounts/acct/registrar/domain-check', query: undefined, body: { domains: ['a"b\\c\n.com'] } })
})

test('requests pass account selection and timeout options to the connector', async () => {
  const { ctx, calls } = fakeCloudflareConnector({ routes: { 'GET /accounts/acct/registrar/registrations': { body: { success: true, result: [] } } } })
  await mcp.requestViaMcp(ctx, { method: 'GET', path: '/accounts/acct/registrar/registrations' }, { accountId: 'acct' })
  assert.equal(calls[0].options.accountId, 'acct')
  assert.equal(calls[0].options.timeoutMs, 120_000)
  assert.deepEqual(calls[0].options, { accountId: 'acct', timeoutMs: 120_000, sensitiveValues: [] })
  assert.equal(calls[0].request.code, undefined)
})

for (const code of ['mcp_error', 'invalid_request', 'invalid_result']) {
  test(`the published ${code} helper error retains its code/status without invented consent`, async () => {
    const { ctx } = fakeCloudflareConnector()
    let requests = 0
    ctx.cloudflareConnector.request = async () => {
      requests += 1
      const error = new Error(`${code}: request-secret-123`)
      error.code = code
      error.status = null
      throw error
    }
    await assert.rejects(
      cloudflare.listDomains({
        accountId: 'acct',
        transport: (request) => mcp.requestViaMcp(ctx, request, { sensitiveValues: ['request-secret-123'] }),
      }),
      (error) => {
        assert.ok(error instanceof HttpError)
        assert.equal(error.code, code)
        assert.equal(error.status, null)
        assert.equal(error.scopes, undefined)
        assert.equal(error.authorizationUrl, undefined)
        assert.doesNotMatch(error.message, /request-secret-123|cloudflare_connector_authorize|CLOUDFLARE_API_TOKEN/)
        assert.doesNotMatch(error.body, /request-secret-123/)
        return true
      },
    )
    assert.equal(requests, 1)
  })
}

test('API failures keep their HTTP status and are redacted', async () => {
  const { ctx } = fakeCloudflareConnector({
    routes: { 'GET /zones': { status: 403, body: { success: false, errors: [{ message: 'denied' }] } } },
  })
  await assert.rejects(
    () => mcp.requestViaMcp(ctx, { method: 'GET', path: '/zones', sensitiveValues: ['epp-secret-code'] }),
    (error) => {
      assert.ok(error instanceof HttpError || error.name === 'HttpError')
      assert.equal(error.status, 403)
      assert.match(error.message, /returned HTTP 403/)
      return true
    },
  )
})

test('the MCP transport adapter redacts declared sensitive values', async () => {
  const secret = 'raw-epp-code-123'
  const { ctx } = fakeCloudflareConnector({
    routes: { 'POST /accounts/acct/registrar/domain-transfer-check': { status: 422, body: { success: false, errors: [{ message: `bad code ${secret}` }] } } },
  })
  await assert.rejects(
    () => mcp.requestViaMcp(ctx, { method: 'POST', path: '/accounts/acct/registrar/domain-transfer-check', body: { auth_code: secret }, sensitiveValues: [secret] }),
    (error) => {
      assert.ok(!error.message.includes(secret))
      return true
    },
  )
})

test('account discovery lists accounts without depending on optional whoami tools', async () => {
  const connection = fakeCloudflareConnector({
    routes: { 'GET /accounts': { body: { success: true, result: [{ id: 'acct456', name: 'Main' }] } } },
  })
  assert.equal(await mcp.discoverAccountId(connection.ctx), 'acct456')
  assert.equal(connection.requests.length, 1)
})

test('account discovery refuses to guess between multiple accounts', async () => {
  const { ctx } = fakeCloudflareConnector({
    routes: { 'GET /accounts': { body: { success: true, result: [{ id: 'acct1' }, { id: 'acct2' }] } } },
  })
  await assert.rejects(() => mcp.discoverAccountId(ctx), /can see 2 accounts; set cloudflare\.accountId/)

  const empty = fakeCloudflareConnector({ routes: { 'GET /accounts': { body: { success: true, result: [] } } } })
  await assert.rejects(() => mcp.discoverAccountId(empty.ctx), /can see no accounts/)
})

test('createTransport resolves the account once, writes it back and reuses it', async () => {
  const { ctx, calls } = fakeCloudflareConnector({
    routes: {
      'GET /accounts': { body: { success: true, result: [{ id: 'acctDiscover' }] } },
      'GET /accounts/acctDiscover/registrar/registrations': { body: { success: true, result: [] } },
    },
  })
  let known
  const transport = mcp.createTransport(ctx, { getAccountId: () => known, onAccountId: (id) => { known = id } })
  assert.equal(await transport.resolveAccountId(), 'acctDiscover')
  assert.equal(await transport.resolveAccountId(), 'acctDiscover')
  assert.equal(known, 'acctDiscover')
  const accountDiscoveryCalls = calls.filter((call) => call.request.path === '/accounts').length
  assert.equal(accountDiscoveryCalls, 1, 'the account list must be fetched once')
  await transport.request({ method: 'GET', path: '/accounts/acctDiscover/registrar/registrations' })
  assert.equal(calls.at(-1).options.accountId, 'acctDiscover')
})

test('listDomains paginates and validates through the MCP transport', async () => {
  const { ctx } = fakeCloudflareConnector({ routes: LIST_ROUTES })
  const domains = await cloudflare.listDomains(transportConfig(ctx))
  assert.deepEqual(domains.map((domain) => domain.name), ['example.com', 'example.dev'])
  assert.equal(Object.hasOwn(domains[0], 'renewalPrice'), false)
  assert.equal(domains[0].autoRenew, true)
})

test('availability, search and zone checks share the REST validation in MCP mode', async () => {
  const { ctx, requests } = fakeCloudflareConnector({
    routes: {
      'POST /accounts/acct/registrar/domain-check': {
        body: { success: true, result: { domains: [{ name: 'example.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '8.57', renewal_cost: '8.57' } }] } },
      },
      'GET /accounts/acct/registrar/domain-search': {
        body: { success: true, result: { domains: [{ name: 'acmecorp.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '10.11', renewal_cost: '10.11' } }] } },
      },
      'GET /zones': { body: { success: true, errors: [], result: [{ name: 'example.com', status: 'active', account: { id: 'acct' }, name_servers: ['kate.ns.cloudflare.com'] }] } },
    },
  })
  const config = transportConfig(ctx)
  const available = await cloudflare.checkAvailability(config, ['example.dev'])
  assert.equal(available[0].registrationPrice, '8.57')
  const search = await cloudflare.searchDomains(config, 'acme corp', { limit: 3 })
  assert.equal(search[0].name, 'acmecorp.dev')
  const zone = await cloudflare.getZoneStatus(config, 'Example.COM')
  assert.deepEqual(zone, { found: true, status: 'active', nameservers: ['kate.ns.cloudflare.com'] })
  const zoneRequest = requests.find((request) => request.path === '/zones')
  assert.deepEqual(zoneRequest.query, { name: 'example.com', 'account.id': 'acct', match: 'all' })
})

test('plain Registrar 403 failures retain API errors and provide explicit read-consent guidance without replay', async () => {
  const { ctx, calls } = fakeCloudflareConnector({
    routes: { 'GET /accounts/acct/registrar/registrations': { status: 403, body: { success: false, errors: [{ message: 'no registrar scope' }] } } },
  })
  await assert.rejects(
    () => cloudflare.listDomains(transportConfig(ctx)),
    (error) => {
      assert.equal(error.code, 'api_error')
      assert.equal(error.status, 403)
      assert.match(error.message, /No scope challenge was supplied/)
      assert.match(error.message, /cloudflare_connector_status.*actual granted scopes/)
      assert.match(error.message, /"scopes":\["registrar-domains.read"\]/)
      assert.match(error.message, /If already granted, do not repeatedly reconnect/)
      assert.doesNotMatch(error.message, /API.token.only|registrar:read/)
      assert.equal(error.authorizationUrl, undefined)
      return true
    },
  )
  assert.equal(calls.length, 1)
})

test('failureHint distinguishes unchallenged MCP failures from API token problems', () => {
  assert.match(cloudflare.failureHint(403, 'denied', { mode: 'mcp' }), /cloudflare_connector_status/)
  assert.doesNotMatch(cloudflare.failureHint(403, 'denied', { mode: 'mcp' }), /API token/)
  assert.match(cloudflare.failureHint(403, 'denied', { mode: 'api' }), /API token|token's permissions/)
  assert.match(cloudflare.failureHint(401, 'denied', { mode: 'api' }), /CLOUDFLARE_API_TOKEN/)
})

for (const [label, run] of [
  ['request adapter', (ctx) => mcp.requestViaMcp(ctx, { path: '/accounts' })],
  ['account discovery', (ctx) => mcp.discoverAccountId(ctx)],
  ['Registrar listing', (ctx) => cloudflare.listDomains(transportConfig(ctx))],
]) {
  test(`invalid_scope retains structured details and gives correction guidance at the ${label} boundary`, async () => {
    const { ctx } = fakeCloudflareConnector()
    let requests = 0
    ctx.cloudflareConnector.request = async () => {
      requests += 1
      const error = new Error('Unsupported scope registrar:read; Bearer fake-oauth-secret')
      error.status = 400
      error.code = 'invalid_scope'
      error.scopes = ['registrar:read']
      throw error
    }
    ctx.cloudflareConnector.authorize = async () => { assert.fail('Requests must not start consent automatically') }
    await assert.rejects(run(ctx), (error) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'invalid_scope')
      assert.deepEqual(error.scopes, ['registrar:read'])
      assert.equal(error.authorizationUrl, undefined)
      assert.match(error.message, /scopes_supported/)
      assert.match(error.message, /Registrar reads use "registrar-domains.read", not "registrar:read"/)
      assert.match(error.message, /Reconnecting with the same invalid scope will not help/)
      assert.doesNotMatch(error.message, /fake-oauth-secret|CLOUDFLARE_API_TOKEN/)
      assert.doesNotMatch(error.body, /fake-oauth-secret/)
      return true
    })
    assert.equal(requests, 1, 'Invalid scopes must not trigger request replay')
  })
}

test('unchallenged Authentication error 10000 retains its status and requires checking the actual grant without replay', async () => {
  for (const status of [200, 401, 403]) {
    const { ctx, calls } = fakeCloudflareConnector({
      routes: { 'GET /accounts/acct/registrar/registrations': { status, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } } },
    })
    await assert.rejects(cloudflare.listDomains(transportConfig(ctx)), (error) => {
      assert.equal(error.status, status)
      assert.equal(error.code, 'api_error')
      assert.match(error.message, /Authentication error 10000/)
      assert.match(error.message, /actual granted scopes/)
      assert.match(error.message, /Another identity-only sign-in may not fix this/)
      assert.match(error.message, /"scopes":\["registrar-domains.read"\]/)
      assert.equal(error.authorizationUrl, undefined)
      assert.doesNotMatch(error.message, /CLOUDFLARE_API_TOKEN|registrar:read/)
      return true
    })
    assert.equal(calls.length, 1)
  }
})

test('unchallenged Registrar write and zone failures suggest only their documented scopes', async () => {
  const { ctx } = fakeCloudflareConnector({
    routes: {
      'POST /accounts/acct/registrar/domain-check': { status: 403, body: { success: false, errors: [] } },
      'GET /zones': { status: 403, body: { success: false, errors: [] } },
    },
  })
  await assert.rejects(cloudflare.checkAvailability(transportConfig(ctx), ['example.dev']), /"scopes":\["registrar-domains.admin"\]/)
  await assert.rejects(cloudflare.getZoneStatus(transportConfig(ctx), 'example.com'), /"scopes":\["zone.read"\]/)
})

test('a missing Cloudflare MCP server fails with connector instructions', async () => {
  const ctx = { tools: { schemas: () => [], execute: async () => ({ results: [] }) } }
  const transport = mcp.createTransport(ctx)
  await assert.rejects(() => transport.request({ method: 'GET', path: '/accounts/x/registrar/registrations' }), /dsh-cloudflare-connector/)
  assert.equal(transport.isAvailable(), false)
})

test('MCP mode discovers the account id and writes it back for later calls', async () => {
  const { ctx } = fakeCloudflareConnector({
    routes: {
      'GET /accounts': { body: { success: true, result: [{ id: 'acctDiscovered' }] } },
      'GET /accounts/acctDiscovered/registrar/registrations': { body: { success: true, result: [], result_info: { cursor: '' } } },
    },
  })

  const config = { transport: (request) => mcp.requestViaMcp(ctx, request, { accountId: config.accountId }), discoverAccountId: () => mcp.discoverAccountId(ctx) }
  assert.equal(config.accountId, undefined)
  assert.deepEqual(await cloudflare.listDomains(config), [])
  assert.equal(config.accountId, 'acctDiscovered', 'the discovered account id is kept for transfer quotes')
})

test('structured authorization errors preserve the exact challenged scopes without invented consent or replay', async () => {
  const { ctx } = fakeCloudflareConnector()
  let requests = 0
  const authorizationUrl = 'https://mcp.cloudflare.com/authorize?state=public-flow-state'
  ctx.cloudflareConnector.request = async () => {
    requests += 1
    const error = new Error('Approve Cloudflare permissions with cloudflare_connector_authorize')
    error.status = 403
    error.code = 'authorization_required'
    error.scopes = ['zone.read']
    error.authorizationUrl = authorizationUrl
    throw error
  }
  ctx.cloudflareConnector.authorize = async () => { assert.fail('Consent must remain explicit') }
  await assert.rejects(cloudflare.listDomains(transportConfig(ctx)), (error) => {
    assert.equal(error.status, 403)
    assert.equal(error.code, 'authorization_required')
    assert.deepEqual(error.scopes, ['zone.read'])
    assert.equal(error.authorizationUrl, authorizationUrl)
    assert.doesNotMatch(error.message, /API token|registrar-domains|No scope challenge/)
    return true
  })
  assert.equal(requests, 1)
  assert.equal(mcp.asHttpError({ message: 'HTTP 404 in unrelated text', status: 422 }).status, 422)
})
