import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'

import { IANA_BOOTSTRAP, loadBootstrap, rdapBasesFor, resetRdapCache } from '../lib/rdap.js'
import { checkViaRdap } from '../lib/availability.js'

const BOOTSTRAP = {
  version: '1.0',
  services: [
    [['com', 'net'], ['https://rdap.verisign.com/com/v1']],
    [['dev', 'app'], ['https://www.registry.google/rdap/']],
  ],
}

function response(status, body) {
  return { status, text: async () => body }
}

beforeEach(() => resetRdapCache())

test('bootstrap maps TLDs and caches the result', async () => {
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    assert.equal(url, IANA_BOOTSTRAP)
    return response(200, JSON.stringify(BOOTSTRAP))
  }
  const services = await loadBootstrap({ fetchImpl })
  assert.deepEqual(services.get('com'), ['https://rdap.verisign.com/com/v1/'])
  assert.deepEqual(services.get('dev'), ['https://www.registry.google/rdap/'])

  // second call is served from cache: no extra fetch
  await loadBootstrap({ fetchImpl })
  assert.equal(calls, 1)
})

test('rdapBasesFor prefers the registry base and keeps rdap.org as fallback', async () => {
  const fetchImpl = async () => response(200, JSON.stringify(BOOTSTRAP))
  assert.deepEqual(await rdapBasesFor('example.com', { fetchImpl }), [
    'https://rdap.verisign.com/com/v1/',
    'https://rdap.org/',
  ])
})

test('rdapBasesFor falls back to rdap.org when the bootstrap fails', async () => {
  const fetchImpl = async () => response(503, 'unavailable')
  assert.deepEqual(await rdapBasesFor('example.com', { fetchImpl }), ['https://rdap.org/'])
})

test('rdapBasesFor falls back to rdap.org for an unmapped TLD', async () => {
  const fetchImpl = async () => response(200, JSON.stringify(BOOTSTRAP))
  assert.deepEqual(await rdapBasesFor('example.zzz', { fetchImpl }), ['https://rdap.org/'])
})

test('checkViaRdap queries the registry base directly and reads 200 as registered', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url === IANA_BOOTSTRAP) return response(200, JSON.stringify(BOOTSTRAP))
    assert.equal(url, 'https://rdap.verisign.com/com/v1/domain/example.com')
    return response(200, JSON.stringify({ events: [{ eventAction: 'expiration', eventDate: '2027-03-15T00:00:00Z' }] }))
  }
  const result = await checkViaRdap('example.com', { fetchImpl })
  assert.equal(result.available, false)
  assert.equal(result.expires, '2027-03-15')
  assert.ok(urls.every((url) => !url.startsWith('https://rdap.org')))
})

test('checkViaRdap reads 404 as available', async () => {
  const fetchImpl = async (url) => {
    if (url === IANA_BOOTSTRAP) return response(200, JSON.stringify(BOOTSTRAP))
    return response(404, 'not found')
  }
  const result = await checkViaRdap('example.dev', { fetchImpl })
  assert.equal(result.available, true)
  assert.equal(result.status, 'available')
})

test('checkViaRdap falls back to the next base when a registry base errors', async () => {
  const fetchImpl = async (url) => {
    if (url === IANA_BOOTSTRAP) return response(200, JSON.stringify(BOOTSTRAP))
    if (url.startsWith('https://rdap.verisign.com')) return response(503, 'registry down')
    assert.ok(url.startsWith('https://rdap.org/'))
    return response(404, 'not found')
  }
  const result = await checkViaRdap('example.com', { fetchImpl })
  assert.equal(result.available, true)
})
