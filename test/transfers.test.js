import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { loadData } from '../lib/store.js'
import { explainReasons } from '../lib/transfers.js'
import * as cloudflare from '../lib/registrars/cloudflare.js'

const CONFIG = { apiToken: 'transfer-test-token', accountId: 'acct' }
const AUTH = 'epp<&"secret+/= code'
const ENCODED = Buffer.from(AUTH, 'utf8').toString('base64')

function response(result, status = 200) {
  return { status, text: async () => JSON.stringify({ success: true, errors: [], result }) }
}

function eligibility(overrides = {}, name = 'example.com') {
  return {
    domains: {
      [name]: {
        name, transferable: true, reasons: [],
        pricing: { transfer_cost: '9.99', renewal_cost: '10.11', currency: 'USD' },
        ...overrides,
      },
    },
  }
}

function workflow(state = 'pending', extra = {}) {
  return { state, completed: ['succeeded', 'failed'].includes(state), context: { domain_name: 'example.com' }, ...extra }
}

function registration(overrides = {}) {
  return { domain_name: 'example.com', status: 'active', expires_at: '2028-03-15T12:00:00Z', auto_renew: true, ...overrides }
}

function mockRegistrarFetch(t, handler) {
  return t.mock.method(globalThis, 'fetch', (url, init) => {
    if (new URL(url).pathname.endsWith('/zones')) {
      return response([{ name: 'example.com', status: 'active', name_servers: [] }])
    }
    return handler(url, init)
  })
}

function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of [AUTH, JSON.stringify(AUTH).slice(1, -1), ENCODED, CONFIG.apiToken]) {
    assert.ok(!text.includes(secret), 'sensitive values must not appear in persisted data or errors')
  }
}

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-transfer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'domains.json')
  const config = { dataFile: file, cloudflare: CONFIG, ...overrides }
  const tools = new Map()
  await apply({ tools: { register: (tool) => tools.set(tool.name, tool) } }, config)
  await tools.get('domain_manager_add').execute({
    name: 'example.com', registrar: 'Namecheap', expires: '2027-03-15', autoRenew: true,
    renewalPrice: 18, promoPrice: 12, icannFee: 0.2, purpose: 'website', group: 'brand', notes: 'keep me',
  })
  return {
    dir, file, config, tools,
    run: (suffix, args) => tools.get(`domain_manager_transfer_${suffix}`).execute({ name: 'example.com', ...args }),
    stored: async () => (await loadData(file)).domains[0],
  }
}

test('Cloudflare transfer endpoints encode raw EPP codes and use the documented request shapes', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return url.endsWith('/domain-transfer-check') ? response(eligibility()) : response(workflow(), 202)
  }
  const checked = await cloudflare.checkTransfer(CONFIG, 'Example.COM', AUTH, { fetchImpl })
  assert.deepEqual(checked, { transferable: true, reasons: [], transferPrice: 9.99, renewalPrice: 10.11, currency: 'USD' })
  assert.deepEqual(JSON.parse(calls[0].init.body), { domains: [{ domain_name: 'example.com', auth_code: ENCODED }] })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/registrar/domain-transfer-check')
  assert.deepEqual(await cloudflare.startTransfer(CONFIG, 'example.com', AUTH, true, { fetchImpl }), { state: 'pending', message: '' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { auth_code: ENCODED, auto_renew: true })
  assert.ok(calls[1].url.endsWith('/registrations/example.com/transfer-in'))
})

test('Cloudflare checks reject missing domains, partial errors, invalid prices and invalid reasons', async () => {
  for (const result of [
    { domains: {} },
    { domains: [] },
    eligibility({}, 'other.com'),
    { domains: { ...eligibility().domains, ...eligibility({}, 'other.com').domains } },
    eligibility({ transferable: 'true' }),
    eligibility({ reasons: [{ code: 'domain_locked' }] }),
    eligibility({ reasons: ['domain_locked'] }),
    eligibility({ pricing: { transfer_cost: '', renewal_cost: '10', currency: 'USD' } }),
    eligibility({ pricing: { transfer_cost: '-1', renewal_cost: '10', currency: 'USD' } }),
    eligibility({ pricing: { transfer_cost: '9', renewal_cost: 'NaN', currency: 'USD' } }),
    eligibility({ pricing: { transfer_cost: '9', renewal_cost: '10', currency: '' } }),
  ]) {
    await assert.rejects(() => cloudflare.checkTransfer(CONFIG, 'example.com', AUTH, { fetchImpl: async () => response(result) }), /invalid|incomplete/)
  }
  await assert.rejects(() => cloudflare.checkTransfer(CONFIG, 'example.com', AUTH, {
    fetchImpl: async () => ({
      status: 200, text: async () => JSON.stringify({ success: true, result: eligibility(), errors: [{ code: 10000, message: 'partial failure' }] }),
    }),
  }), /incomplete/)
  assert.deepEqual(await cloudflare.checkTransfer(CONFIG, 'example.com', AUTH, {
    fetchImpl: async () => response(eligibility({ transferable: false, reasons: [{ code: 'domain_locked' }] })),
  }), { transferable: false, reasons: ['domain_locked'] })
})

test('UK transfers omit auth codes; other domains require them and credentials', async () => {
  await assert.rejects(() => cloudflare.checkTransfer({}, 'example.com', AUTH), /not configured/)
  await assert.rejects(() => cloudflare.checkTransfer(CONFIG, 'example.com'), /EPP code/)
  await assert.rejects(() => cloudflare.checkTransfer(CONFIG, 'example.com', ' '), /non-empty/)
  await assert.rejects(() => cloudflare.checkTransfer(CONFIG, 'not a domain', AUTH), /FQDN/)
  await cloudflare.checkTransfer(CONFIG, 'example.co.uk', undefined, {
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { domains: [{ domain_name: 'example.co.uk' }] })
      return response(eligibility({}, 'example.co.uk'))
    },
  })
})

test('authorization codes and encoded equivalents are redacted from HTTP, envelope and transport errors', async () => {
  for (const fetchImpl of [
    async () => ({ status: 400, text: async () => `bad ${AUTH}; encoded ${ENCODED}` }),
    async () => ({ status: 400, text: async () => JSON.stringify({ message: `bad ${AUTH}; encoded ${ENCODED}` }) }),
    async () => ({ status: 200, text: async () => JSON.stringify({ success: false, errors: [{ message: `${AUTH}; ${ENCODED}` }] }) }),
    async () => { throw new Error(`bad ${AUTH}; ${ENCODED}`) },
  ]) {
    await assert.rejects(() => cloudflare.checkTransfer(CONFIG, 'example.com', AUTH, { fetchImpl }), (error) => {
      assertNoSecrets(error.message)
      assertNoSecrets(error)
      return true
    })
  }
})

test('workflow validation rejects inconsistent completion, wrong domains and missing failure details', async () => {
  for (const result of [
    workflow('unknown'),
    workflow('succeeded', { completed: false }),
    workflow('pending', { completed: true }),
    workflow('pending', { context: { domain_name: 'other.com' } }),
    workflow('failed'),
  ]) {
    await assert.rejects(() => cloudflare.getTransferStatus(CONFIG, 'example.com', { fetchImpl: async () => response(result) }), /invalid|requires error/)
  }
  const status = await cloudflare.startTransfer(CONFIG, 'example.com', AUTH, false, {
    fetchImpl: async () => response(workflow('failed', { error: { code: 'rejected', message: `bad ${AUTH}; ${ENCODED}` } })),
  })
  assert.match(status.message, /rejected/)
  assert.ok(!status.message.includes(AUTH))
  assert.ok(!status.message.includes(ENCODED))
})

test('eligibility check persists a secret-free quote without changing registration facts', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async (_url, init) => {
    assert.ok(!String(_url).endsWith('/transfer-in'))
    assert.equal(init.method, 'POST')
    return response(eligibility())
  })
  const checked = await h.run('check', { authCode: AUTH, autoRenew: false })
  assert.equal(checked.transfer.state, 'ready')
  assert.equal(checked.transfer.autoRenew, false)
  assert.equal(checked.transfer.transferPrice, 9.99)
  assert.ok(checked.steps.some((step) => /DNSSEC/.test(step)))
  assert.ok(checked.steps.some((step) => /email/i.test(step)))
  assert.match(h.tools.get('domain_manager_transfer_check').output.render({}, checked)[0].text, /non-refundable/)
  const raw = await readFile(h.file, 'utf8')
  assertNoSecrets(raw)
  const stored = await h.stored()
  assert.equal(stored.registrar, 'Namecheap')
  assert.equal(stored.expires, '2027-03-15')
  assert.equal(stored.autoRenew, true)
  assert.equal(stored.renewalPrice, 18)
  assert.equal(stored.transfer.quoteId, checked.transfer.quoteId)
  if (process.platform !== 'win32') assert.equal((await stat(h.file)).mode & 0o777, 0o600)
  const list = await h.tools.get('domain_manager_list').execute({})
  assert.equal(list.domains[0].transfer.state, 'ready')
  assert.match(h.tools.get('domain_manager_list').output.render({}, list)[0].text, /transfer to Cloudflare: ready/)
})

test('unsupported routes, missing credentials and unknown domains fail explicitly', async (t) => {
  const h = await setup(t, { cloudflare: {} })
  mockRegistrarFetch(t, async () => { throw new Error('must not fetch') })
  await assert.rejects(() => h.run('check', { toRegistrar: 'godaddy', authCode: AUTH }), /Only Namecheap/)
  await assert.rejects(() => h.run('check', { name: 'missing.com', authCode: AUTH }), /unknown domain/)
  await assert.rejects(() => h.run('check', { authCode: AUTH }), /not configured/)
  await h.tools.get('domain_manager_update').execute({ name: 'example.com', registrar: 'Other' })
  await assert.rejects(() => h.run('check', { authCode: AUTH }), /Only Namecheap/)
})

test('start requires explicit confirmation, a current ready quote, and the same Cloudflare account', async (t) => {
  const h = await setup(t)
  const mock = mockRegistrarFetch(t, async () => response(eligibility()))
  await assert.rejects(() => h.run('start', { confirm: true, authCode: AUTH }), /transfer_check/)
  const checked = await h.run('check', { authCode: AUTH })
  const args = { quoteId: checked.transfer.quoteId, authCode: AUTH }
  for (const confirm of [undefined, false, 'true', 1]) {
    await assert.rejects(() => h.run('start', { ...args, confirm }), /Explicit user confirmation/)
  }
  await assert.rejects(() => h.run('start', { ...args, quoteId: 'old', confirm: true }), /current ready quote/)
  const tools = new Map()
  await apply({ tools: { register: (tool) => tools.set(tool.name, tool) } }, { ...h.config, cloudflare: { ...CONFIG, accountId: 'different' } })
  await assert.rejects(() => tools.get('domain_manager_transfer_start').execute({ name: 'example.com', ...args, confirm: true }), /different Cloudflare account/)
  // The check makes two reads: the transfer quote plus the best-effort zone probe.
  assert.equal(mock.mock.callCount(), 2)
})

test('blocked eligibility and changed fees, renewals or currencies never submit a transfer', async (t) => {
  for (const changed of [
    { transferable: false, reasons: [{ code: 'domain_locked' }] },
    { pricing: { transfer_cost: '11', renewal_cost: '10.11', currency: 'USD' } },
    { pricing: { transfer_cost: '9.99', renewal_cost: '20', currency: 'USD' } },
    { pricing: { transfer_cost: '9.99', renewal_cost: '10.11', currency: 'EUR' } },
  ]) {
    const h = await setup(t)
    let checks = 0
    mockRegistrarFetch(t, async (url) => {
      assert.ok(String(url).endsWith('/domain-transfer-check'))
      return response(eligibility(checks++ === 0 ? {} : changed))
    })
    const checked = await h.run('check', { authCode: AUTH })
    await assert.rejects(() => h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }), /eligibility or pricing changed/)
    const stored = await h.stored()
    assert.equal(stored.registrar, 'Namecheap')
    assert.notEqual(stored.transfer.quoteId, checked.transfer.quoteId)
    assert.equal(stored.transfer.state, changed.transferable === false ? 'ineligible' : 'ready')
  }
})

test('pending submission persists before POST, survives restart, rejects duplicate starts and unsafe removals', async (t) => {
  const h = await setup(t)
  let submissions = 0
  mockRegistrarFetch(t, async (url, init) => {
    if (String(url).endsWith('/transfer-in')) {
      submissions += 1
      assert.equal((await h.stored()).transfer.state, 'submitting')
      assert.equal(JSON.parse(init.body).auto_renew, true)
      return response(workflow(), 202)
    }
    return response(eligibility())
  })
  const checked = await h.run('check', { authCode: AUTH })
  const args = { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }
  const outcomes = await Promise.allSettled([h.run('start', args), h.run('start', args)])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  assert.equal(submissions, 1)
  assert.equal((await h.stored()).registrar, 'Namecheap')
  assert.equal((await h.stored()).transfer.state, 'pending')
  const tools = new Map()
  await apply({ tools: { register: (tool) => tools.set(tool.name, tool) } }, h.config)
  await assert.rejects(() => tools.get('domain_manager_transfer_start').execute({ name: 'example.com', ...args }), /already submitted/)
  await assert.rejects(() => h.run('check', { authCode: AUTH }), /already submitted/)
  await assert.rejects(() => h.tools.get('domain_manager_remove').execute({ name: 'example.com' }), /active or unknown transfer/)
  await assert.rejects(() => h.tools.get('domain_manager_update').execute({ name: 'example.com', registrar: 'Cloudflare' }), /Cannot change registrar/)
  const path = join(h.dir, 'portfolio.md')
  await h.tools.get('domain_manager_export_markdown').execute({ path })
  await assert.rejects(() => h.tools.get('domain_manager_import_markdown').execute({ path, replace: true }), /Cannot replace/)
  const markdown = await readFile(path, 'utf8')
  await writeFile(path, markdown.replaceAll('Namecheap', 'Cloudflare'))
  await assert.rejects(() => h.tools.get('domain_manager_import_markdown').execute({ path }), /Cannot change registrar/)
})

test('unknown submission outcomes remain tracked and can be recovered through status without resubmitting', async (t) => {
  const h = await setup(t)
  let submissions = 0
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/transfer-in')) {
      submissions += 1
      throw new Error(`network disconnected after ${AUTH} ${ENCODED}`)
    }
    if (String(url).endsWith('/transfer-in-status')) return response(workflow('in_progress'))
    return response(eligibility())
  })
  const checked = await h.run('check', { authCode: AUTH })
  await assert.rejects(() => h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }), (error) => {
    assert.match(error.message, /outcome may be unknown/)
    assert.ok(!error.message.includes(AUTH))
    assert.ok(!error.message.includes(ENCODED))
    return true
  })
  assert.equal((await h.stored()).transfer.state, 'submitting')
  await assert.rejects(() => h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }), /outcome unknown/)
  assert.equal((await h.run('status', {})).transfer.state, 'in_progress')
  assert.equal(submissions, 1)
})

test('status exposes required action and failure, without changing registrar facts', async (t) => {
  const h = await setup(t)
  let state = 'action_required'
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    if (String(url).endsWith('/transfer-in')) return response(workflow(), 202)
    if (state === 'failed') return response(workflow('failed', { error: { code: 'transfer_rejected', message: 'Losing registrar rejected the transfer' } }))
    return response(workflow(state, { context: { domain_name: 'example.com', foa_required: true, action: { type: 'approve_email' } } }))
  })
  const checked = await h.run('check', { authCode: AUTH })
  await h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId })
  const required = await h.run('status', {})
  assert.equal(required.transfer.state, 'action_required')
  assert.match(required.transfer.message, /approve_email/)
  assert.match(required.transfer.message, /authorization email/)
  state = 'blocked'
  assert.equal((await h.run('status', {})).transfer.state, 'blocked')
  state = 'failed'
  const failed = await h.run('status', {})
  assert.equal(failed.transfer.state, 'failed')
  assert.match(failed.transfer.message, /transfer_rejected.*Losing registrar/)
  assert.equal((await h.stored()).registrar, 'Namecheap')
  assert.equal((await h.stored()).renewalPrice, 18)
})

test('completion refreshes expiry and auto-renew, clears source-only prices and keeps curation', async (t) => {
  const h = await setup(t)
  let registrationReady = false
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    if (String(url).endsWith('/transfer-in')) return response(workflow(), 202)
    if (String(url).endsWith('/transfer-in-status')) return response(workflow('succeeded'))
    return response(registration(registrationReady ? {} : { status: 'transfer_pending', expires_at: null }))
  })
  const checked = await h.run('check', { authCode: AUTH })
  await h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId })
  await assert.rejects(() => h.run('status', {}), /not active/)
  assert.equal((await h.stored()).registrar, 'Namecheap')
  registrationReady = true
  assert.equal((await h.run('status', {})).transfer.state, 'succeeded')
  const stored = await h.stored()
  assert.equal(stored.registrar, 'Cloudflare')
  assert.equal(stored.expires, '2028-03-15')
  assert.equal(stored.autoRenew, true)
  assert.equal(stored.renewalPrice, 10.11)
  assert.equal(stored.promoPrice, null)
  assert.equal(stored.icannFee, null)
  assert.equal(stored.purpose, 'website')
  assert.equal(stored.group, 'brand')
  assert.equal(stored.notes, 'keep me')
  assert.equal(stored.source, 'cloudflare')
  assert.ok(stored.syncedAt)
  const report = await h.tools.get('domain_manager_report').execute({})
  assert.equal(report.totalAnnual, 10.11)
  assert.equal(report.icannFeesAnnual, 0)
  await h.tools.get('domain_manager_update').execute({ name: 'example.com', renewalPrice: 11.25 })
  await h.run('status', {})
  assert.equal((await h.stored()).expires, '2028-03-15')
  assert.equal((await h.stored()).renewalPrice, 11.25, 'repeated status must not overwrite refreshed pricing with the old transfer quote')
})

test('definitively rejected requests are tracked as failed and need a new quote before retrying', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/transfer-in')) {
      return { status: 400, text: async () => JSON.stringify({ message: `invalid ${AUTH} ${ENCODED}` }) }
    }
    return response(eligibility())
  })
  const checked = await h.run('check', { authCode: AUTH })
  const args = { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }
  await assert.rejects(() => h.run('start', args), /HTTP 400/)
  assert.equal((await h.stored()).transfer.state, 'failed')
  const raw = await readFile(h.file, 'utf8')
  assertNoSecrets(raw)
  await assert.rejects(() => h.run('start', args), /current ready quote/)
  assert.equal((await h.run('check', { authCode: AUTH })).transfer.state, 'ready')
})

test('an uncertain submission with no remote workflow reports failure and requires explicit retry approval', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/transfer-in')) throw new Error('connection lost')
    if (String(url).endsWith('/transfer-in-status')) return { status: 404, text: async () => 'No workflow found' }
    return response(eligibility())
  })
  const checked = await h.run('check', { authCode: AUTH })
  await assert.rejects(() => h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }), /outcome may be unknown/)
  const status = await h.run('status', {})
  assert.equal(status.transfer.state, 'failed')
  assert.match(status.transfer.message, /Verify the dashboard/)
  assert.equal((await h.stored()).registrar, 'Namecheap')
})

test('stale losing-registrar rows cannot revert a completed transfer during sync-all', async (t) => {
  const h = await setup(t, {
    namecheap: { apiUser: 'transfer-sync-test', apiKey: 'key', clientIp: '203.0.113.1' },
  })
  mockRegistrarFetch(t, async (url) => {
    const target = String(url)
    if (target.endsWith('/domain-transfer-check')) return response(eligibility())
    if (target.endsWith('/transfer-in')) return response(workflow(), 202)
    if (target.endsWith('/transfer-in-status')) return response(workflow('succeeded'))
    if (target.endsWith('/registrations/example.com')) return response(registration())
    if (target.includes('getList')) return {
      status: 200,
      text: async () => '<ApiResponse Status="OK"><CommandResponse><DomainGetListResult><Domain Name="example.com" Expires="03/15/2027" AutoRenew="true" IsPremium="false"/></DomainGetListResult><Paging><TotalItems>1</TotalItems><PageSize>100</PageSize></Paging></CommandResponse></ApiResponse>',
    }
    if (target.includes('getPricing')) return {
      status: 200,
      text: async () => '<ApiResponse Status="OK"><CommandResponse><UserGetPricingResult><ProductCategory Name="renew"><Product Name="com"><Price Duration="1" DurationType="YEAR" Price="18" RegularPrice="18" AdditionalCost="0.2"/></Product></ProductCategory></UserGetPricingResult></CommandResponse></ApiResponse>',
    }
    return response([{
      name: 'example.com', expires_at: '2028-03-15T12:00:00Z', auto_renew: true,
      fees: { renewal_fee: 11.25, currency: 'USD' },
    }])
  })
  const checked = await h.run('check', { authCode: AUTH })
  await h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId })
  const active = await h.tools.get('domain_manager_sync').execute({ registrar: 'all' })
  assert.ok(active.warnings.some((warning) => /ignored Cloudflare/.test(warning)))
  assert.equal((await h.stored()).registrar, 'Namecheap')
  await h.run('status', {})
  const synced = await h.tools.get('domain_manager_sync').execute({ registrar: 'all' })
  assert.ok(synced.warnings.some((warning) => /ignored Namecheap/.test(warning)))
  assert.equal((await h.stored()).registrar, 'Cloudflare')
  assert.equal((await h.stored()).transfer.state, 'succeeded')
  assert.equal((await h.stored()).renewalPrice, 11.25)
  assert.equal((await h.stored()).icannFee, null)
  assert.equal((await h.stored()).promoPrice, null)
  await h.run('status', {})
  assert.equal((await h.stored()).renewalPrice, 11.25)
})

test('registrar sync preserves active transfers and does not prematurely move the portfolio', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    if (String(url).endsWith('/transfer-in')) return response(workflow(), 202)
    return response([{
      name: 'example.com', expires_at: '2028-03-15T12:00:00Z', auto_renew: true,
      fees: { renewal_fee: 10.11, currency: 'USD' },
    }])
  })
  const checked = await h.run('check', { authCode: AUTH })
  await h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId })
  const synced = await h.tools.get('domain_manager_sync').execute({ registrar: 'cloudflare' })
  assert.ok(synced.warnings.some((warning) => /verified transfer completion/.test(warning)))
  assert.equal((await h.stored()).registrar, 'Namecheap')
  assert.equal((await h.stored()).transfer.state, 'pending')
})

test('transfer records validate strictly and discard unknown secret-bearing fields', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async () => response(eligibility()))
  await h.run('check', { authCode: AUTH })
  const data = JSON.parse(await readFile(h.file, 'utf8'))
  data.domains[0].transfer.authCode = AUTH
  await writeFile(h.file, JSON.stringify(data))
  await h.tools.get('domain_manager_update').execute({ name: 'example.com', purpose: 'updated' })
  assertNoSecrets(await readFile(h.file, 'utf8'))
  data.domains[0].transfer.state = 'nonsense'
  await writeFile(h.file, JSON.stringify(data))
  await assert.rejects(() => loadData(h.file), /invalid transfer state/)
})

test('transfer records reject malformed advisory warnings', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async () => response(eligibility()))
  await h.run('check', { authCode: AUTH })
  const data = JSON.parse(await readFile(h.file, 'utf8'))
  data.domains[0].transfer.warnings = ['ok', 7]
  await writeFile(h.file, JSON.stringify(data))
  await assert.rejects(() => loadData(h.file), /transfer.warnings must be strings/)
  data.domains[0].transfer.warnings = [{ detail: 'not a string' }]
  await writeFile(h.file, JSON.stringify(data))
  await assert.rejects(() => loadData(h.file), /transfer.warnings must be strings/)
})

test('checks explain blockers in plain language and state that nothing was charged', async (t) => {
  const h = await setup(t)
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/zones?name=')) return response([])
    return response(eligibility({ transferable: false, reasons: [{ code: 'zone_not_active' }] }))
  })
  const checked = await h.run('check', { authCode: AUTH })
  assert.equal(checked.transfer.state, 'ineligible')
  assert.ok(checked.explanation.some((entry) => /^zone_not_active: /.test(entry)))
  assert.ok(checked.explanation.some((entry) => /registrar nameservers/i.test(entry)))
  const text = h.tools.get('domain_manager_transfer_check').output.render({}, checked)[0].text
  assert.match(text, /not eligible yet/)
  assert.match(text, /Why blocked:/)
  assert.match(text, /nothing was submitted and nothing was charged/i)
  assert.match(text, /Fix every blocker/)
  assert.match(text, /fresh quote/)
})

test('checks warn before submission when the Cloudflare zone is missing or still pending', async (t) => {
  const h = await setup(t)
  let zone = [{ name: 'example.com', status: 'pending', name_servers: ['kay.ns.cloudflare.com', 'kyrie.ns.cloudflare.com'] }]
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/zones?name=')) return response(zone)
    return response(eligibility())
  })
  const pending = await h.run('check', { authCode: AUTH })
  assert.equal(pending.transfer.state, 'ready')
  assert.ok(pending.transfer.warnings.some((warning) => /"pending", not "active"/.test(warning)))
  assert.ok(pending.transfer.warnings.some((warning) => /kay\.ns\.cloudflare\.com/.test(warning)))
  assert.match(h.tools.get('domain_manager_transfer_check').output.render({}, pending)[0].text, /Heads-up:/)
  zone = []
  const missing = await h.run('check', { authCode: AUTH })
  assert.ok(missing.transfer.warnings.some((warning) => /No Cloudflare zone found/.test(warning)))
  assert.match(h.tools.get('domain_manager_transfer_check').output.render({}, missing)[0].text, /Add a site/)
})

test('unchanged checks keep the existing quote ID instead of forcing a new approval', async (t) => {
  const h = await setup(t)
  let transferCost = '9.99'
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/zones?name=')) return response([])
    return response(eligibility({ pricing: { transfer_cost: transferCost, renewal_cost: '10.11', currency: 'USD' } }))
  })
  const first = await h.run('check', { authCode: AUTH })
  const second = await h.run('check', { authCode: AUTH })
  assert.equal(second.transfer.quoteId, first.transfer.quoteId)
  assert.match(second.transfer.message, /still valid/)
  assert.match(h.tools.get('domain_manager_transfer_check').output.render({}, second)[0].text, /still valid/)
  transferCost = '11.5'
  const changed = await h.run('check', { authCode: AUTH })
  assert.notEqual(changed.transfer.quoteId, first.transfer.quoteId)
  assert.match(changed.transfer.message, /previous quote changed/)
})

test('awaiting-approval transfers tell the user how to finish without resubmitting', async (t) => {
  const h = await setup(t)
  const blocked = workflow('blocked', { context: { domain_name: 'example.com', transfer_status: 'awaiting_approval' } })
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url)
    if (target.includes('/zones?name=')) return response([])
    if (target.endsWith('/transfer-in')) return response(blocked, 202)
    if (target.endsWith('/transfer-in-status')) return response(blocked)
    return response(eligibility())
  })
  const checked = await h.run('check', { authCode: AUTH })
  await h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId })
  const status = await h.run('status', {})
  assert.equal(status.transfer.state, 'blocked')
  const text = h.tools.get('domain_manager_transfer_status').output.render({}, status)[0].text
  assert.match(text, /awaiting approval/)
  assert.match(text, /approve/i)
  assert.match(text, /5 days/)
  assert.match(text, /non-refundable/)
  const list = await h.tools.get('domain_manager_list').execute({})
  assert.match(h.tools.get('domain_manager_list').output.render({}, list)[0].text, /awaiting approval/)
})

test('Cloudflare auth, permission and IP failures carry actionable hints', async () => {
  const cases = [
    [401, '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', /restart the app/],
    [403, '{"success":false,"errors":[{"code":0,"message":"Requires permission \\"com.cloudflare.api.account.zone.create\\""}]}', /Account-scoped/],
    [403, '{"success":false,"errors":[{"code":9109,"message":"Cannot use the access token from location: 203.0.113.9"}]}', /IP Address Filtering/],
    [200, '{"success":false,"errors":[{"code":9109,"message":"Cannot use the access token from location: 203.0.113.9"}]}', /IP Address Filtering/],
  ]
  for (const [status, body, pattern] of cases) {
    await assert.rejects(
      () => cloudflare.checkTransfer(CONFIG, 'example.com', AUTH, { fetchImpl: async () => ({ status, text: async () => body }) }),
      pattern,
    )
  }
})

test('zone lookup scopes the request to the destination account and validates responses', async () => {
  await assert.rejects(() => cloudflare.getZoneStatus({}, 'example.com'), /not configured/)
  assert.deepEqual(
    await cloudflare.getZoneStatus(CONFIG, 'Example.COM', {
      fetchImpl: async (url, init) => {
        const parsed = new URL(url)
        assert.equal(parsed.searchParams.get('name'), 'example.com')
        assert.equal(parsed.searchParams.get('account.id'), CONFIG.accountId)
        assert.equal(parsed.searchParams.get('match'), 'all')
        assert.equal(init.method, 'GET')
        return response([{ name: 'example.com', status: 'active', account: { id: CONFIG.accountId }, name_servers: ['a.ns.cloudflare.com'] }])
      },
    }),
    { found: true, status: 'active', nameservers: ['a.ns.cloudflare.com'] },
  )
  assert.deepEqual(
    await cloudflare.getZoneStatus(CONFIG, 'example.com', { fetchImpl: async () => response([]) }),
    { found: false, status: 'missing', nameservers: [] },
  )
  for (const fetchImpl of [
    async () => ({ status: 403, text: async () => '{"success":false,"errors":[]}' }),
    async () => ({ status: 200, text: async () => JSON.stringify({ success: true, result: {} }) }),
    async () => ({ status: 200, text: async () => JSON.stringify({ success: false, result: [], errors: [{ message: CONFIG.apiToken }] }) }),
    async () => response([{ name: 'example.com', status: 'active', account: { id: 'other-account' } }]),
    async () => response([{ name: 'other.com', status: 'active' }]),
    async () => response([{ name: 'example.com', status: 'active' }, { name: 'example.com', status: 'pending' }]),
    async () => response([{ name: 'example.com', status: 'active', name_servers: ['valid', 7] }]),
    async () => { throw new Error('network down') },
  ]) {
    await assert.rejects(() => cloudflare.getZoneStatus(CONFIG, 'example.com', { fetchImpl }), (error) => {
      assertNoSecrets(error.message)
      return true
    })
  }
})

test('HTTP conflicts preserve uncertain submission state until the existing workflow is reconciled', async (t) => {
  const h = await setup(t)
  let submissions = 0
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    if (String(url).endsWith('/transfer-in')) {
      submissions += 1
      return { status: 409, text: async () => 'A workflow already exists; use GET status' }
    }
    assert.ok(String(url).endsWith('/transfer-in-status'))
    return response(workflow('in_progress'))
  })
  const checked = await h.run('check', { authCode: AUTH })
  const args = { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }
  await assert.rejects(() => h.run('start', args), /outcome may be unknown/)
  assert.equal((await h.stored()).transfer.state, 'submitting')
  await assert.rejects(() => h.run('check', { authCode: AUTH }), /outcome unknown/)
  await assert.rejects(() => h.run('start', args), /outcome unknown/)
  assert.equal((await h.run('status', {})).transfer.state, 'in_progress')
  assert.equal(submissions, 1)
})

test('a generic 404 cannot discard uncertain transfer tracking', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    if (String(url).endsWith('/transfer-in')) throw new Error('connection lost')
    return { status: 404, text: async () => 'Not found' }
  })
  const checked = await h.run('check', { authCode: AUTH })
  await assert.rejects(() => h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }), /outcome may be unknown/)
  await assert.rejects(() => h.run('status', {}), /HTTP 404/)
  assert.equal((await h.stored()).transfer.state, 'submitting')
  await assert.rejects(() => h.run('check', { authCode: AUTH }), /outcome unknown/)
})

test('zone lookup failures remain visible even when eligibility already reports zone blockers', async (t) => {
  const h = await setup(t)
  let blocked = false
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/zones?')) {
      return { status: 403, text: async () => JSON.stringify({ success: false, errors: [{ message: `denied ${CONFIG.apiToken}` }] }) }
    }
    assert.ok(String(url).endsWith('/domain-transfer-check'))
    return response(eligibility(blocked ? { transferable: false, reasons: [{ code: 'zone_not_found' }] } : {}))
  })
  for (const isBlocked of [false, true]) {
    blocked = isBlocked
    const checked = await h.run('check', { authCode: AUTH })
    assert.equal(checked.transfer.state, blocked ? 'ineligible' : 'ready')
    assert.ok(checked.transfer.warnings.some((warning) => /readiness could not be verified.*HTTP 403/.test(warning)))
    assertNoSecrets(checked)
    const rendered = h.tools.get('domain_manager_transfer_check').output.render({}, checked)[0].text
    assert.match(rendered, /Heads-up:/)
    assert.match(rendered, /Zone read permission/)
  }
})

test('rendered billing describes registry-dependent expiry and does not claim a verified charge', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    if (String(url).endsWith('/transfer-in')) return response(workflow('succeeded'), 202)
    return response(registration())
  })
  const checked = await h.run('check', { authCode: AUTH })
  const checkText = h.tools.get('domain_manager_transfer_check').output.render({}, checked)[0].text
  assert.match(checkText, /Successful completion normally charges/)
  assert.match(checkText, /zero-fee extensions are not charged/)
  assert.match(checkText, /registry rules/)
  const completed = await h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId })
  const statusText = h.tools.get('domain_manager_transfer_status').output.render({}, completed)[0].text
  assert.match(statusText, /Verify payment in the dashboard/)
  assert.doesNotMatch(statusText, /one year was added|fee was applied/)
})

test('unchanged quotes refresh check time while changed auto-renew invalidates approval', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async () => response(eligibility()))
  const checked = await h.run('check', { authCode: AUTH })
  const data = JSON.parse(await readFile(h.file, 'utf8'))
  data.domains[0].transfer.checkedAt = '2020-01-01T00:00:00.000Z'
  await writeFile(h.file, JSON.stringify(data))
  const refreshed = await h.run('check', { authCode: AUTH })
  assert.equal(refreshed.transfer.quoteId, checked.transfer.quoteId)
  assert.ok(Date.parse(refreshed.transfer.checkedAt) > Date.parse(data.domains[0].transfer.checkedAt))
  const changed = await h.run('check', { authCode: AUTH, autoRenew: false })
  assert.notEqual(changed.transfer.quoteId, checked.transfer.quoteId)
  await assert.rejects(() => h.run('start', { authCode: AUTH, confirm: true, quoteId: checked.transfer.quoteId }), /current ready quote/)
})

test('canonical transfer blockers give specific next steps while unknown codes remain visible', () => {
  for (const [code, expected] of [
    ['invalid_auth_code', /fresh code/],
    ['invalid_auth_code_format', /raw EPP/],
    ['domain_premium', /dashboard/],
    ['extension_not_supported_via_api', /dashboard/],
    ['extension_not_supported', /does not support/],
    ['domain_outside_transfer_window', /waiting period/],
    ['domain_max_term', /maximum registration term/],
    ['domain_on_cloudflare', /sync/],
    ['invalid_zone_plan', /full-setup/],
    ['future_registry_blocker', /Address this Cloudflare-reported blocker/],
  ]) {
    const [explanation] = explainReasons([code])
    assert.ok(explanation.startsWith(`${code}: `))
    assert.match(explanation, expected)
  }
})

test('ready quotes warn of an extra registration year and require explicit approval before submission', async (t) => {
  const h = await setup(t)
  let submissions = 0
  mockRegistrarFetch(t, async (url) => {
    if (String(url).endsWith('/domain-transfer-check')) return response(eligibility())
    assert.ok(String(url).endsWith('/transfer-in'))
    submissions += 1
    return response(workflow(), 202)
  })
  const checked = await h.run('check', { authCode: AUTH, autoRenew: false })
  assert.match(checked.confirmationPrompt, /may extend your registration by one year at Cloudflare/)
  assert.match(checked.confirmationPrompt, /bill for that additional year as part of the quoted transfer fee, even if auto-renew is off/)
  assert.match(checked.confirmationPrompt, /Do you explicitly confirm transferring example\.com from Namecheap to Cloudflare/)
  assert.match(checked.confirmationPrompt, /9\.99 USD.*10\.11 USD\/year.*auto-renew off/)
  assert.ok(checked.steps.some((step) => /Ask the user the confirmationPrompt and wait for explicit approval/.test(step)))
  const tool = h.tools.get('domain_manager_transfer_check')
  assert.equal(tool.output.schema.properties.confirmationPrompt.type, 'string')
  const rendered = tool.output.render({}, checked)[0].text
  assert.match(rendered, /Confirmation required.*ask the user and wait/)
  assert.ok(rendered.includes(checked.confirmationPrompt))
  assertNoSecrets(checked)
  for (const confirm of [undefined, false]) {
    await assert.rejects(() => h.run('start', { authCode: AUTH, quoteId: checked.transfer.quoteId, confirm }), /bill for another year.*wait for explicit approval/)
    assert.equal(submissions, 0)
    assert.equal((await h.stored()).transfer.state, 'ready')
  }
  const submitted = await h.run('start', { authCode: AUTH, quoteId: checked.transfer.quoteId, confirm: true })
  assert.equal(submissions, 1)
  assert.equal(submitted.transfer.state, 'pending')
  assert.equal(submitted.confirmationPrompt, undefined)
})

test('zero-fee transfer confirmation mentions a possible extension without claiming an additional charge', async (t) => {
  const h = await setup(t)
  mockRegistrarFetch(t, async () => response(eligibility({
    pricing: { transfer_cost: '0', renewal_cost: '10.11', currency: 'USD' },
  })))
  const checked = await h.run('check', { authCode: AUTH })
  assert.match(checked.confirmationPrompt, /may extend your registration by one year/)
  assert.match(checked.confirmationPrompt, /quoted transfer fee is 0 USD; zero-fee extensions are not charged/)
  assert.match(checked.confirmationPrompt, /Do you explicitly confirm transferring/)
  assert.doesNotMatch(checked.confirmationPrompt, /may bill for/)
})
