import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as mcp from '../lib/providers/mcp.js'

const NC_TOOLS = [
  { name: 'mcp__namecheap__domains_list', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__namecheap__domains_check_availability', parameters: { type: 'object', properties: { domains: { type: 'array' } } } },
]

function fakeCtx({ schemas = NC_TOOLS, results = {} } = {}) {
  const calls = []
  return {
    calls,
    tools: {
      schemas: () => schemas,
      execute: async ({ calls: batch }) => {
        const call = batch[0]
        calls.push(call)
        const handler = results[call.name]
        if (!handler) throw new Error(`unexpected tool ${call.name}`)
        return { results: [{ callId: call.id, result: typeof handler === 'function' ? await handler(call.arguments) : handler }] }
      },
    },
  }
}

test('detects the registrar MCP server by tool prefix', () => {
  assert.equal(mcp.isAvailable(NC_TOOLS), true)
  assert.equal(mcp.isAvailable([]), false)
  assert.equal(mcp.isAvailable([{ name: 'mcp__other__domains_list' }]), false)
  assert.equal(mcp.findTool(NC_TOOLS, 'domains_list')?.name, 'mcp__namecheap__domains_list')
  assert.equal(mcp.findTool(NC_TOOLS, 'domains_list', { server: 'cloudflare' }), null)
})

test('buildArgs maps logical arguments onto the declared parameter names', () => {
  const tool = { parameters: { properties: { domain_list: { type: 'array' } } } }
  assert.deepEqual(mcp.buildArgs(tool, { domains: ['a.com'] }), { domain_list: ['a.com'] })
  assert.deepEqual(mcp.buildArgs(tool, {}), {})
  // no declared properties: fall back to the logical name
  assert.deepEqual(mcp.buildArgs({ parameters: {} }, { domains: ['a.com'] }), { domains: ['a.com'] })
})

test('unwrapResult prefers canonical value, then structured content, then JSON text', () => {
  assert.deepEqual(mcp.unwrapResult({ value: { domains: [1] }, content: [] }), { domains: [1] })
  assert.deepEqual(mcp.unwrapResult({ structuredContent: { domains: [2] } }), { domains: [2] })
  assert.deepEqual(mcp.unwrapResult({ content: [{ type: 'text', text: '{"domains":[3]}' }] }), { domains: [3] })
  assert.equal(mcp.unwrapResult({ content: [{ type: 'text', text: 'plain text' }] }), 'plain text')
  assert.throws(() => mcp.unwrapResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }), /boom/)
  assert.throws(() => mcp.unwrapResult(undefined), /no result/)
})

test('normalizes registrar rows from messy MCP payloads', () => {
  const row = mcp.normalizeDomainRow({
    DomainName: 'Example.COM',
    expirationDate: '03/15/2027',
    auto_renew: 'yes',
    renewalFee: '$9.15',
    currencyCode: 'usd',
  })
  assert.deepEqual(
    { name: row.name, expires: row.expires, autoRenew: row.autoRenew, price: row.renewalPrice, currency: row.currency },
    { name: 'example.com', expires: '2027-03-15', autoRenew: true, price: 9.15, currency: 'USD' },
  )
  assert.equal(mcp.normalizeDomainRow({ name: 'no-date.com' }), null)
  assert.equal(mcp.toIsoDate(1794182400), '2026-11-09')
  assert.equal(mcp.toBool('false'), false)
  assert.equal(mcp.toNumber('USD 12.20'), 12.2)
})

test('listDomains calls the MCP tool with no args and returns normalized rows', async () => {
  const ctx = fakeCtx({
    results: {
      'mcp__namecheap__domains_list': {
        content: [{ type: 'text', text: JSON.stringify({ domains: [{ name: 'example.com', expires: '2027-03-15', autoRenew: true, renewalPrice: 9.15 }] }) }],
      },
    },
  })
  const rows = await mcp.listDomains(ctx)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].registrar, 'Namecheap')
  assert.equal(rows[0].name, 'example.com')
  assert.equal(ctx.calls[0].arguments && Object.keys(ctx.calls[0].arguments).length, 0)
})

test('listDomains accepts a canonical value and wrapper keys', async () => {
  const ctx = fakeCtx({
    results: {
      'mcp__namecheap__domains_list': { value: { items: [{ name: 'example.dev', expiresAt: '2027-04-01T00:00:00Z' }] } },
    },
  })
  const rows = await mcp.listDomains(ctx)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].expires, '2027-04-01')
  assert.equal(rows[0].autoRenew, false)
})

test('listDomains explains how to connect the server when it is missing', async () => {
  await assert.rejects(() => mcp.listDomains(fakeCtx({ schemas: [] })), /dsh-namecheap-mcp/)
})

test('unwrapResult unwraps the MCP bridge canonical value envelope', () => {
  // @deepseek-ai/dsh-mcp-client executes an MCP tool into { content, structuredContent? }
  // and the tool runtime hands that whole object back as result.value.
  assert.deepEqual(
    mcp.unwrapResult({ value: { content: [{ type: 'text', text: '{"items":[{"name":"example.com"}]}' }] } }),
    { items: [{ name: 'example.com' }] },
  )
  // The structured payload wins when the server supplies one.
  assert.deepEqual(
    mcp.unwrapResult({ value: { content: [{ type: 'text', text: 'ignored' }], structuredContent: { items: [1] } } }),
    { items: [1] },
  )
  // An envelope reached downstream still yields rows instead of silently nothing.
  assert.deepEqual(mcp.asRows({ content: [{ type: 'text', text: '{"items":[{"name":"a.com"}]}' }] }), [{ name: 'a.com' }])
})

test('listDomains reads rows from the canonical MCP value envelope', async () => {
  const ctx = fakeCtx({
    results: {
      'mcp__namecheap__domains_list': {
        value: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                items: [{ name: 'beings.agency', expirationDate: '2027-03-15T00:00:00.000Z', autoRenew: false }],
                total: 1,
              }),
            },
          ],
        },
      },
    },
  })
  const rows = await mcp.listDomains(ctx)
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { name: rows[0].name, expires: rows[0].expires, autoRenew: rows[0].autoRenew },
    { name: 'beings.agency', expires: '2027-03-15', autoRenew: false },
  )
})

test('checkAvailability passes names under the declared argument and normalizes prices', async () => {
  const ctx = fakeCtx({
    results: {
      'mcp__namecheap__domains_check_availability': {
        value: {
          domains: [
            { name: 'example.dev', available: true, premium: true, registrationPrice: '120.00', currency: 'USD' },
            { name: 'example.com', available: false },
          ],
        },
      },
    },
  })
  const rows = await mcp.checkAvailability(ctx, ['example.dev', 'example.com'])
  assert.deepEqual(ctx.calls[0].arguments, { domains: ['example.dev', 'example.com'] })
  assert.equal(rows[0].available, true)
  assert.equal(rows[0].premium, true)
  assert.equal(rows[0].registrationPrice, 120)
  assert.equal(rows[0].source, 'namecheap-mcp')
  assert.equal(rows[1].available, false)
})

test('MCP canonical error envelopes propagate instead of becoming empty success', () => {
  const result = { value: { isError: true, content: [{ type: 'text', text: 'registrar unavailable' }] } }
  assert.throws(() => mcp.unwrapResult(result), /registrar unavailable/)
  assert.throws(() => mcp.asRows(result), /registrar unavailable/)
})

test('MCP structured arrays take precedence over JSON text', () => {
  assert.deepEqual(mcp.unwrapResult({
    structuredContent: [1],
    content: [{ type: 'text', text: '{"items":[2]}' }],
  }), [1])
})

test('MCP malformed and circular envelopes fail without recursion or silent empty results', () => {
  for (const payload of [{ content: [] }, { content: [{ type: 'text', text: 'not domain data' }] }, { total: 1 }]) {
    assert.throws(() => mcp.asRows(payload), /domain array/)
  }
  const cycle = {}
  cycle.value = cycle
  assert.throws(() => mcp.asRows(cycle), /cyclic MCP/)
  assert.deepEqual(mcp.asRows({ value: { items: [] } }), [])
})

test('MCP invalid registration and availability rows are rejected', async () => {
  await assert.rejects(() => mcp.listDomains(fakeCtx({
    results: { 'mcp__namecheap__domains_list': { value: { items: [{ name: 'example.com' }] } } },
  })), /invalid row/)
  await assert.rejects(() => mcp.listDomains(fakeCtx({
    results: { 'mcp__namecheap__domains_list': { value: { items: [{ name: 'example.com', expires: '2027-02-30' }] } } },
  })), /not a real date/)
  await assert.rejects(() => mcp.listDomains(fakeCtx({
    results: { 'mcp__namecheap__domains_list': { value: { items: [{ name: 'example.com', expires: '2027-03-15', autoRenew: 'invalid' }] } } },
  })), /invalid auto-renew/)
  await assert.rejects(() => mcp.checkAvailability(fakeCtx({
    results: { 'mcp__namecheap__domains_check_availability': { value: { items: [{ name: 'example.com' }] } } },
  }), ['example.com']), /invalid row/)
})

test('MCP calls time out even when a tool ignores the abort signal', async () => {
  let signal
  const ctx = {
    tools: {
      execute: ({ signal: passed }) => {
        signal = passed
        return new Promise(() => {})
      },
    },
  }
  await assert.rejects(() => mcp.callTool(ctx, 'stalled', {}, { timeoutMs: 20 }), /timed out after 20ms/)
  assert.equal(signal.aborted, true)
})
