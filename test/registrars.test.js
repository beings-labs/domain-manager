import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as namecheap from '../lib/registrars/namecheap.js'
import * as cloudflare from '../lib/registrars/cloudflare.js'

function response(body, status = 200) {
  return { status, text: async () => body }
}

const NC_LIST = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain Name="example.com" Expires="03/15/2027" AutoRenew="true" IsPremium="false" />
      <Domain Name="example.dev" Expires="2028-02-28" AutoRenew="false" IsPremium="true" />
    </DomainGetListResult>
    <Paging><TotalItems>2</TotalItems><PageSize>100</PageSize></Paging>
  </CommandResponse>
</ApiResponse>`

const NC_CHECK = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.domains.check">
    <DomainCheckResult Domain="example.com" Available="false" IsPremium="false" ErrorNo="0" />
    <DomainCheckResult Domain="example.dev" Available="true" IsPremium="true" PremiumPrice="120.00" ErrorNo="0" />
  </CommandResponse>
</ApiResponse>`

const NC_ERROR = `<?xml version="1.0"?>
<ApiResponse Status="ERROR">
  <Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors>
</ApiResponse>`

test('namecheap lists domains and normalizes dates', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return response(NC_LIST)
  }
  const domains = await namecheap.listDomains(
    { apiUser: 'u', apiKey: 'k', clientIp: '203.0.113.1' },
    { fetchImpl },
  )
  assert.equal(domains.length, 2)
  assert.deepEqual(domains[0], {
    name: 'example.com',
    registrar: 'Namecheap',
    expires: '2027-03-15',
    autoRenew: true,
    premium: false,
    currency: 'USD',
    renewalPrice: null,
  })
  assert.equal(domains[1].expires, '2028-02-28')
  assert.match(calls[0], /Command=namecheap\.domains\.getList/)
  // credentials travel in the query string and are never exposed in the URL we log
  assert.match(calls[0], /ApiKey=k/)
})

test('namecheap requires credentials before calling out', async () => {
  await assert.rejects(() => namecheap.listDomains({}), /not configured/)
  await assert.rejects(() => namecheap.checkAvailability({ apiUser: 'u' }, ['example.com']), /not configured/)
})

test('namecheap surfaces API errors without leaking the key', async () => {
  const fetchImpl = async () => response(NC_ERROR)
  await assert.rejects(
    () => namecheap.listDomains({ apiUser: 'u', apiKey: 'secret-key', clientIp: '1.2.3.4' }, { fetchImpl }),
    (error) => {
      assert.match(error.message, /API Key is invalid/)
      assert.doesNotMatch(error.message, /secret-key/)
      return true
    },
  )
})

test('namecheap checks availability including premium pricing', async () => {
  const fetchImpl = async () => response(NC_CHECK)
  const results = await namecheap.checkAvailability(
    { apiUser: 'u', apiKey: 'k', clientIp: '1.2.3.4' },
    ['example.com', 'example.dev'],
    { fetchImpl },
  )
  assert.equal(results.length, 2)
  assert.equal(results[0].available, false)
  assert.equal(results[1].available, true)
  assert.equal(results[1].premium, true)
  assert.equal(results[1].premiumPrice, '120.00')
  assert.equal(results[1].source, 'namecheap')
})

const CF_LIST = {
  success: true,
  result: [
    {
      domain_name: 'example.com', expires_at: '2027-03-15T12:00:00.000Z', auto_renew: true, status: 'active',
    },
    {
      domain_name: 'example.dev', expires_at: '2028-02-28T00:00:00.000Z', auto_renew: false, status: 'active',
    },
  ],
  result_info: { count: 2, per_page: 50, cursor: '' },
}

test('cloudflare lists current registrations without fabricating prices or premium flags', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return response(JSON.stringify(CF_LIST))
  }
  const domains = await cloudflare.listDomains({ apiToken: 't', accountId: 'acct' }, { fetchImpl })
  assert.equal(domains.length, 2)
  assert.equal(domains[0].expires, '2027-03-15')
  assert.equal(Object.hasOwn(domains[0], 'renewalPrice'), false)
  assert.equal(Object.hasOwn(domains[1], 'premium'), false)
  assert.match(calls[0].url, /accounts\/acct\/registrar\/registrations\?per_page=50$/)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t')
})

test('cloudflare follows opaque registration cursors without using page numbers', async () => {
  const pages = [
    { success: true, result: [CF_LIST.result[0]], result_info: { cursor: 'opaque +/next' } },
    { success: true, result: [CF_LIST.result[1]], result_info: { cursor: '' } },
  ]
  let index = 0
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams
    assert.equal(query.get('per_page'), '50')
    assert.equal(query.has('page'), false)
    assert.equal(query.get('cursor'), index === 0 ? null : 'opaque +/next')
    return response(JSON.stringify(pages[index++]))
  }
  const domains = await cloudflare.listDomains({ apiToken: 't', accountId: 'acct' }, { fetchImpl })
  assert.equal(domains.length, 2)
  assert.equal(index, 2)
})

test('cloudflare reports API errors from the envelope', async () => {
  const fetchImpl = async () =>
    response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }))
  await assert.rejects(
    () => cloudflare.listDomains({ apiToken: 'bad', accountId: 'acct' }, { fetchImpl }),
    (error) => {
      assert.match(error.message, /10000 Authentication error/)
      assert.match(error.message, /Fix cloudflare.apiToken/)
      assert.match(error.message, /restart the app/)
      assert.match(error.message, /does not switch to OAuth after a failure/)
      return true
    },
  )
})

test('cloudflare checks availability and search', async () => {
  const checkBody = {
    success: true,
    result: {
      domains: [
        { name: 'example.com', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '9.15', renewal_cost: '9.15' } },
        { name: 'example.dev', registrable: false, tier: 'premium', reason: 'taken' },
      ],
    },
  }
  const fetchImpl = async (url, init) => {
    if (url.includes('domain-search')) {
      return response(JSON.stringify({ success: true, result: { domains: [{ name: 'acme.com', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '8.57' } }] } }))
    }
    assert.equal(init.method, 'POST')
    return response(JSON.stringify(checkBody))
  }
  const results = await cloudflare.checkAvailability(
    { apiToken: 't', accountId: 'acct' },
    ['example.com', 'example.dev'],
    { fetchImpl },
  )
  assert.equal(results[0].available, true)
  assert.equal(results[0].registrationPrice, '9.15')
  assert.equal(results[1].available, false)
  assert.equal(results[1].detail, 'taken')

  const search = await cloudflare.searchDomains({ apiToken: 't', accountId: 'acct' }, 'acme', { fetchImpl })
  assert.equal(search[0].name, 'acme.com')
  assert.equal(search[0].registrationPrice, '8.57')
})

const NC_PRICING = `<?xml version="1.0"?>
<ApiResponse Status="OK">
  <CommandResponse Type="namecheap.users.getPricing">
    <UserGetPricingResult>
      <ProductType Name="domains">
        <ProductCategory Name="renew">
          <Product Name="com">
            <Price Duration="1" DurationType="YEAR" Price="10.00" RegularPrice="12.00" AdditionalCost="0.20" />
            <Price Duration="2" DurationType="YEAR" Price="20.00" RegularPrice="24.00" AdditionalCost="0.20" />
          </Product>
          <Product Name="co.uk">
            <Price Duration="1" DurationType="YEAR" Price="6.50" RegularPrice="6.50" AdditionalCost="0.00" />
          </Product>
          <Product Name="id">
            <Price Duration="1" DurationType="YEAR" Price="25.98" RegularPrice="25.98" />
          </Product>
        </ProductCategory>
      </ProductType>
    </UserGetPricingResult>
  </CommandResponse>
</ApiResponse>`

test('namecheap renew pricing maps regular price, promo and ICANN fee per TLD', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return response(NC_PRICING)
  }
  const pricing = await namecheap.getRenewPricing(
    { apiUser: 'u', apiKey: 'k', clientIp: '203.0.113.1' },
    { fetchImpl, maxAgeMs: 0 },
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0], /Command=namecheap\.users\.getPricing/)
  assert.match(calls[0], /ActionName=RENEW/)
  assert.match(calls[0], /ProductType=DOMAIN/)

  // promo TLD: regular price is the steady-state renewal, discounted price is the promo
  assert.deepEqual(pricing.get('com'), { renewalPrice: 12, promoPrice: 10, icannFee: 0.2, currency: 'USD' })
  // equal price means no promo; a 0.00 ICANN cost means no fee
  assert.deepEqual(pricing.get('co.uk'), { renewalPrice: 6.5, promoPrice: null, icannFee: null, currency: 'USD' })
  // ccTLD with no AdditionalCost attribute at all
  assert.deepEqual(pricing.get('id'), { renewalPrice: 25.98, promoPrice: null, icannFee: null, currency: 'USD' })
})

test('namecheap pricing feed is cached per account and can be filtered by TLD', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return response(NC_PRICING)
  }
  const config = { apiUser: 'cached-user', apiKey: 'k', clientIp: '203.0.113.1' }
  const full = await namecheap.getRenewPricing(config, { fetchImpl, maxAgeMs: 60_000 })
  assert.equal(calls, 1)
  assert.ok(full.has('com'))
  const filtered = await namecheap.getRenewPricing(config, { fetchImpl, maxAgeMs: 60_000, tlds: ['co.uk'] })
  assert.equal(calls, 1, 'a cached feed must not hit the network again')
  assert.deepEqual([...filtered.keys()], ['co.uk'])
})

test('namecheap pricing rejects a feed with no renewal prices', async () => {
  const empty = `<?xml version="1.0"?>
<ApiResponse Status="OK"><CommandResponse Type="namecheap.users.getPricing"><UserGetPricingResult /></CommandResponse></ApiResponse>`
  await assert.rejects(
    () =>
      namecheap.getRenewPricing(
        { apiUser: 'empty-user', apiKey: 'k', clientIp: '203.0.113.1' },
        { fetchImpl: async () => response(empty), maxAgeMs: 0 },
      ),
    /no renewal prices/,
  )
})

test('namecheap tld matching prefers the longest known suffix', () => {
  assert.equal(namecheap.tldOf('example.com', ['com', 'co.uk']), 'com')
  assert.equal(namecheap.tldOf('example.co.uk', ['com', 'co.uk']), 'co.uk')
  assert.equal(namecheap.tldOf('deep.example.co.uk', ['co.uk']), 'co.uk')
  assert.equal(namecheap.tldOf('example.zz', []), 'zz')
  assert.equal(namecheap.tldOf('localhost', ['com']), null)
})

test('Namecheap refuses malformed domain lists and truncation at the page limit', async () => {
  const config = { apiUser: 'u', apiKey: 'k', clientIp: '203.0.113.1' }
  await assert.rejects(() => namecheap.listDomains(config, {
    fetchImpl: async () => response('<ApiResponse Status="OK"><CommandResponse/></ApiResponse>'),
  }), /no DomainGetListResult/)
  await assert.rejects(() => namecheap.listDomains(config, {
    fetchImpl: async () => response(NC_LIST),
    pageSize: 1,
    maxPages: 1,
  }), /refusing a partial sync/)
  await assert.rejects(() => namecheap.listDomains(config, { pageSize: 0 }), /positive safe integers/)
})

test('Namecheap missing yearly prices do not become zero-dollar renewal quotes', async () => {
  const missingPrice = NC_PRICING.replace('Price="10.00"', '')
  const prices = await namecheap.getRenewPricing(
    { apiUser: 'missing-price', apiKey: 'k', clientIp: '203.0.113.1' },
    { fetchImpl: async () => response(missingPrice), maxAgeMs: 0 },
  )
  assert.equal(prices.has('com'), false)
  assert.equal(prices.get('co.uk').renewalPrice, 6.5)
})

test('Namecheap pricing cache isolates delegated usernames and protects cached quotes from mutation', async () => {
  const config = { apiUser: 'delegated-pricing', apiKey: 'k', clientIp: '203.0.113.1', userName: 'first-user' }
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return response(NC_PRICING)
  }
  const prices = await namecheap.getRenewPricing(config, { fetchImpl })
  prices.get('com').renewalPrice = 0
  const cached = await namecheap.getRenewPricing(config, { fetchImpl })
  assert.equal(cached.get('com').renewalPrice, 12)
  assert.equal(calls, 1)
  await namecheap.getRenewPricing({ ...config, userName: 'second-user' }, { fetchImpl })
  assert.equal(calls, 2)
})

test('Namecheap availability surfaces per-domain errors instead of marking the domain taken', async () => {
  await assert.rejects(() => namecheap.checkAvailability(
    { apiUser: 'u', apiKey: 'k', clientIp: '203.0.113.1' },
    ['example.com'],
    { fetchImpl: async () => response(NC_CHECK.replace('ErrorNo="0"', 'ErrorNo="2011169"')) },
  ), /availability failed.*2011169/)
})

test('Cloudflare rejects missing success envelopes, malformed registrations and invalid cursors', async () => {
  const config = { apiToken: 't', accountId: 'acct' }
  for (const payload of [
    { result: [] },
    { success: true },
    { ...CF_LIST, result_info: {} },
    { ...CF_LIST, result_info: { cursor: 123 } },
    { ...CF_LIST, result_info: { cursor: 'a'.repeat(257) } },
    { ...CF_LIST, result: [{ ...CF_LIST.result[0], auto_renew: 'false' }] },
    { ...CF_LIST, result: [{ ...CF_LIST.result[0], expires_at: null, status: 'transfer_pending' }] },
    { ...CF_LIST, result: [null] },
  ]) {
    await assert.rejects(() => cloudflare.listDomains(config, {
      fetchImpl: async () => response(JSON.stringify(payload)),
    }), /Cloudflare/)
  }
})

test('Cloudflare valid empty portfolios remain supported', async () => {
  const domains = await cloudflare.listDomains({ apiToken: 't', accountId: 'acct' }, {
    fetchImpl: async () => response('{"success":true,"result":[],"result_info":{"cursor":""}}'),
  })
  assert.deepEqual(domains, [])
})

test('Cloudflare rejects repeated cursors and enforces the registrations page-size limit', async () => {
  const config = { apiToken: 't', accountId: 'acct' }
  for (const perPage of [0, 51, 1.5]) {
    await assert.rejects(cloudflare.listDomains(config, { perPage }), /between 1 and 50/)
  }
  let calls = 0
  await assert.rejects(cloudflare.listDomains(config, {
    fetchImpl: async () => {
      calls++
      return response(JSON.stringify({ ...CF_LIST, result_info: { cursor: 'repeat' } }))
    },
  }), /repeated.*cursor/)
  assert.equal(calls, 2)
})

test('Cloudflare availability does not coerce string false into true', async () => {
  await assert.rejects(() => cloudflare.checkAvailability({ apiToken: 't', accountId: 'acct' }, ['example.com'], {
    fetchImpl: async () => response('{"success":true,"result":{"domains":[{"name":"example.com","registrable":"false"}]}}'),
  }), /invalid availability result/)
})

test('registrar success-status error envelopes redact API keys echoed as ordinary text', async () => {
  await assert.rejects(() => namecheap.listDomains({ apiUser: 'u', apiKey: 'secret-key', clientIp: '203.0.113.1' }, {
    fetchImpl: async () => response(NC_ERROR.replace('API Key is invalid or API access has not been enabled', 'rejected secret-key')),
  }), (error) => {
    assert.match(error.message, /rejected/)
    assert.ok(!error.message.includes('secret-key'))
    return true
  })
  await assert.rejects(() => cloudflare.listDomains({ apiToken: 'secret-token', accountId: 'acct' }, {
    fetchImpl: async () => response('{"success":false,"errors":[{"message":"rejected secret-token"}]}'),
  }), (error) => {
    assert.match(error.message, /rejected/)
    assert.ok(!error.message.includes('secret-token'))
    return true
  })
})
