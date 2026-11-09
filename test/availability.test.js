import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'

import { checkAvailability, checkViaRdap, normalizeNames } from '../lib/availability.js'
import { resetRdapCache } from '../lib/rdap.js'

beforeEach(() => resetRdapCache())

const RDAP_REGISTERED = JSON.stringify({
  objectClassName: 'domain',
  ldhName: 'example.com',
  events: [
    { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-03-15T00:00:00Z' },
  ],
})

function response(status, body) {
  return { status, text: async () => body }
}

test('normalizeNames cleans input and rejects junk', () => {
  assert.deepEqual(normalizeNames('Example.COM, https://www.example.dev/path ;example.net.'), [
    'example.com',
    'example.dev',
    'example.net',
  ])
  assert.throws(() => normalizeNames('not a domain'), /not a valid domain/)
  assert.throws(() => normalizeNames(''), /at least one domain/)
  const many = Array.from({ length: 21 }, (_, index) => `example${index}.com`).join(',')
  assert.throws(() => normalizeNames(many), /at most 20/)
})

test('RDAP 200 means registered and exposes the expiry date', async () => {
  const result = await checkViaRdap('example.com', {
    fetchImpl: async () => response(200, RDAP_REGISTERED),
  })
  assert.equal(result.available, false)
  assert.equal(result.status, 'registered')
  assert.equal(result.expires, '2027-03-15')
  assert.equal(result.source, 'rdap')
})

test('RDAP 404 means available', async () => {
  const result = await checkViaRdap('example.dev', { fetchImpl: async () => response(404, 'not found') })
  assert.equal(result.available, true)
  assert.equal(result.status, 'available')
})

test('RDAP network errors surface as errors, not as availability', async () => {
  await assert.rejects(
    () => checkViaRdap('example.com', { fetchImpl: async () => response(503, 'upstream down') }),
    /HTTP 503/,
  )
})

test('orchestrator falls back to RDAP when no registrar is configured', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    return response(404, '')
  }
  const value = await checkAvailability('example.dev', { fetchImpl })
  assert.equal(value.provider, 'rdap')
  assert.equal(value.results[0].available, true)
  // bootstrap is consulted first, then the domain's registry base (or rdap.org fallback)
  assert.ok(urls.some((url) => url.includes('rdap.org/domain/example.dev')))
  assert.ok(urls[0].includes('data.iana.org/rdap/dns.json'))
})

test('orchestrator prefers configured Cloudflare and returns pricing', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /registrar\/domain-check/)
    return response(200, JSON.stringify({
      success: true,
      result: { domains: [{ name: 'example.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '8.57', renewal_cost: '8.57' } }] },
    }))
  }
  const value = await checkAvailability('example.dev', {
    cloudflare: { apiToken: 't', accountId: 'acct' },
    fetchImpl,
  })
  assert.equal(value.provider, 'cloudflare')
  assert.equal(value.results[0].available, true)
  assert.equal(value.results[0].registrationPrice, '8.57')
})

test('explicit rdap provider skips configured registrars', async () => {
  const value = await checkAvailability('example.dev', {
    cloudflare: { apiToken: 't', accountId: 'acct' },
    namecheap: { apiUser: 'u', apiKey: 'k', clientIp: '1.2.3.4' },
    provider: 'rdap',
    fetchImpl: async () => response(404, ''),
  })
  assert.equal(value.provider, 'rdap')
})

test('availability rejects empty, partial, duplicate and malformed provider results', async () => {
  const names = ['example.com', 'example.dev']
  for (const results of [
    [],
    [{ name: names[0], available: false }],
    [{ name: names[0], available: false }, { name: names[0], available: true }],
    [{ name: names[0], available: 'false' }, { name: names[1], available: true }],
    [{ name: names[0], available: false }, { name: 'other.com', available: true }],
    null,
  ]) {
    await assert.rejects(() => checkAvailability(names, {
      providers: [{ name: 'broken', run: async () => results }],
    }), /availability provider/)
  }
})

test('availability falls back on incomplete responses and surfaces redacted warnings', async () => {
  const result = await checkAvailability('example.com', {
    providers: [
      { name: 'incomplete', run: async () => [] },
      { name: 'failed', run: async () => { throw new Error('failed with Bearer secret-token') } },
      { name: 'working', run: async (names) => names.map((name) => ({ name, available: false })) },
    ],
  })
  assert.equal(result.provider, 'working')
  assert.equal(result.results[0].available, false)
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings[0], /omitted domains/)
  assert.ok(!result.warnings.join(' ').includes('secret-token'))
})

test('explicit registrar availability refuses an empty success response', async () => {
  await assert.rejects(() => checkAvailability('example.com', {
    provider: 'cloudflare',
    cloudflare: { apiToken: 't', accountId: 'acct' },
    fetchImpl: async () => response(200, '{"success":true,"result":{"domains":[]}}'),
  }), /omitted domains/)
})
