import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseDomainsMarkdown, renderDomainsMarkdown } from '../lib/markdown.js'

const DOCUMENT = `# Domain Portfolio

## Cloudflare Registrar (2 domains)

| Domain | Purpose | Group | Renewal Price | Expires | Auto-renew | Notes |
|--------|---------|-------|---------------|---------|------------|-------|
| example.com | Marketing site | brand | $12.20/year | Mar 12, 2027 | yes | - |
| example.dev | Testing | other | $10.00/year *(promo: $8.00)* | 2027-04-01 | no | premium domain |

## Namecheap (1 domains)

| Domain | Renewal Price | Expires | Auto-renew |
|---|---|---|---|
| example.net | unknown | 2028-01-02 | no |

## Domains to Acquire

| Domain | Notes |
|---|---|
| idea.com | maybe |
`

test('parses portfolio tables and ignores non-portfolio tables', () => {
  const { domains, skipped } = parseDomainsMarkdown(DOCUMENT)
  assert.equal(domains.length, 3)
  assert.deepEqual(domains.map((domain) => domain.name), ['example.com', 'example.dev', 'example.net'])
  assert.equal(domains[0].registrar, 'Cloudflare')
  assert.equal(domains[0].group, 'brand')
  assert.equal(domains[0].purpose, 'Marketing site')
  assert.equal(domains[0].autoRenew, true)
  assert.equal(domains[0].renewalPrice, 12.2)
  assert.equal(domains[1].promoPrice, 8)
  assert.equal(domains[1].notes, 'premium domain')
  assert.equal(domains[1].expires, '2027-04-01')
  assert.equal(domains[2].registrar, 'Namecheap')
  assert.equal(domains[2].renewalPrice, null)
  assert.equal(skipped.length, 1)
})

test('round-trips a portfolio through render and parse', () => {
  const data = {
    version: 1,
    updatedAt: new Date().toISOString(),
    domains: [
      {
        name: 'example.com', registrar: 'Cloudflare', expires: '2027-03-12', autoRenew: true,
        renewalPrice: 12.2, currency: 'USD', promoPrice: null, purpose: 'Marketing site',
        group: 'brand', notes: null, source: null, syncedAt: null,
      },
      {
        name: 'example.net', registrar: 'Namecheap', expires: '2028-01-02', autoRenew: false,
        renewalPrice: null, currency: 'USD', promoPrice: 9.99, purpose: null,
        group: null, notes: 'watch renewal price', source: 'namecheap', syncedAt: null,
      },
    ],
  }
  const markdown = renderDomainsMarkdown(data, { asOf: '2026-11-08' })
  assert.match(markdown, /## Cloudflare \(1 domains\)/)
  assert.match(markdown, /## Namecheap \(1 domains\)/)
  assert.match(markdown, /Total annual renewal cost: \$12\.20\/year/)
  assert.match(markdown, /Auto-renew enabled costs \$12\.20\/year/)

  const parsed = parseDomainsMarkdown(markdown)
  assert.equal(parsed.domains.length, 2)
  const byName = new Map(parsed.domains.map((domain) => [domain.name, domain]))
  assert.equal(byName.get('example.com').autoRenew, true)
  assert.equal(byName.get('example.com').renewalPrice, 12.2)
  assert.equal(byName.get('example.com').purpose, 'Marketing site')
  assert.equal(byName.get('example.net').promoPrice, 9.99)
  assert.equal(byName.get('example.net').renewalPrice, null)
  assert.equal(byName.get('example.net').notes, 'watch renewal price')
  assert.equal(byName.get('example.net').registrar, 'Namecheap')
})

test('rendering an empty portfolio is still valid markdown', () => {
  const markdown = renderDomainsMarkdown({ domains: [] }, {})
  assert.match(markdown, /^# Domain Portfolio/)
  assert.match(markdown, /Total annual renewal cost: \$0\.00\/year/)
})

test('markdown preserves ICANN fees, currencies, custom registrars and literal cell text', () => {
  const domain = {
    name: 'example.com', registrar: 'Custom registrar', expires: '2027-03-15', autoRenew: true,
    renewalPrice: 12, promoPrice: 10, icannFee: 0.2, currency: 'EUR',
    purpose: 'a | b', group: 'literal *group*', notes: 'keep \\| and *stars*',
  }
  const markdown = renderDomainsMarkdown({ domains: [domain] }, { asOf: '2026-11-08' })
  const parsed = parseDomainsMarkdown(markdown).domains[0]
  for (const key of Object.keys(domain)) assert.equal(parsed[key], domain[key], key)
})

test('unknown renewal prices stay unknown when only fees or promos are present', () => {
  const markdown = renderDomainsMarkdown({ domains: [{
    name: 'example.com', registrar: 'Namecheap', expires: '2027-03-15', autoRenew: false,
    renewalPrice: null, promoPrice: 9.99, icannFee: 0.2, currency: 'USD',
  }] }, { asOf: '2026-11-08' })
  const [domain] = parseDomainsMarkdown(markdown).domains
  assert.equal(domain.renewalPrice, null)
  assert.equal(domain.promoPrice, 9.99)
  assert.equal(domain.icannFee, 0.2)
})
