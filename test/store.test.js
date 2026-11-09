import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  addDomain, daysLeft, emptyData, findDomain, loadData, normalizeDomain, removeDomain,
  round2, saveData, summarize, updateDomain, upsertDomain, writeFileAtomic,
} from '../lib/store.js'

const TODAY = new Date('2026-11-08T12:00:00Z')

function domain(overrides = {}) {
  return {
    name: 'example.com',
    registrar: 'Cloudflare',
    expires: '2027-03-12',
    autoRenew: false,
    renewalPrice: 10,
    currency: 'USD',
    ...overrides,
  }
}

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-'))
  return join(dir, 'domains.json')
}

test('a missing store file is an empty portfolio, not an error', async () => {
  const data = await loadData(await tmpStore())
  assert.deepEqual(data.domains, [])
  assert.equal(data.version, 1)
})

test('normalizes names, prices and empty strings', () => {
  const normalized = normalizeDomain(domain({ name: '  Example.COM ', renewalPrice: 12.204, purpose: '   ', group: 'brand' }))
  assert.equal(normalized.name, 'example.com')
  assert.equal(normalized.renewalPrice, 12.2)
  assert.equal(normalized.purpose, null)
  assert.equal(normalized.group, 'brand')
})

test('validates fields loudly', () => {
  for (const [patch, message] of [
    [{ name: 'not a domain' }, /lowercase FQDN/],
    [{ expires: '2027-02-30' }, /not a real date/],
    [{ expires: '03/12/2027' }, /YYYY-MM-DD/],
    [{ renewalPrice: -1 }, /non-negative/],
    [{ registrar: '' }, /registrar must be a non-empty string/],
    [{ autoRenew: 'yes' }, /autoRenew must be a boolean/],
    [{ currency: '' }, /currency must be a non-empty string/],
  ]) {
    assert.throws(() => normalizeDomain(domain(patch)), message)
  }
  assert.doesNotThrow(() => normalizeDomain(domain({ renewalPrice: null })))
})

test('add, update, upsert and remove keep the store consistent', async () => {
  const file = await tmpStore()
  let data = emptyData()

  data = addDomain(data, domain())
  assert.throws(() => addDomain(data, domain()), /already exists/)

  data = updateDomain(data, 'example.com', { autoRenew: true, renewalPrice: 20 })
  assert.equal(findDomain(data, 'example.com').autoRenew, true)
  assert.equal(findDomain(data, 'example.com').renewalPrice, 20)
  assert.throws(() => updateDomain(data, 'missing.dev', { autoRenew: true }), /unknown domain/)

  // upsert from a registrar sync keeps locally curated fields when they are omitted
  data = updateDomain(data, 'example.com', { purpose: 'marketing site', group: 'brand' })
  data = upsertDomain(data, { name: 'example.com', registrar: 'Cloudflare', expires: '2027-06-01', autoRenew: false, renewalPrice: 22 })
  const merged = findDomain(data, 'example.com')
  assert.equal(merged.expires, '2027-06-01')
  assert.equal(merged.purpose, 'marketing site')
  assert.equal(merged.group, 'brand')

  await saveData(file, data)
  const reloaded = await loadData(file)
  assert.equal(reloaded.domains.length, 1)

  data = removeDomain(reloaded, 'example.com')
  assert.equal(data.domains.length, 0)
  assert.throws(() => removeDomain(data, 'example.com'), /unknown domain/)
})

test('corrupt and duplicate stores fail instead of silently starting empty', async () => {
  const file = await tmpStore()
  await writeFile(file, '{ nope', 'utf8')
  await assert.rejects(() => loadData(file), /not valid JSON/)

  const duplicate = {
    version: 1,
    updatedAt: new Date().toISOString(),
    domains: [domain(), domain()],
  }
  await writeFile(file, JSON.stringify(duplicate), 'utf8')
  await assert.rejects(() => loadData(file), /duplicate domain/)
})

test('summary separates auto-renew costs and reports unpriced domains', () => {
  const data = {
    version: 1,
    updatedAt: new Date().toISOString(),
    domains: [
      domain({ name: 'a.com', autoRenew: true, renewalPrice: 10 }),
      domain({ name: 'b.com', autoRenew: false, renewalPrice: 20 }),
      domain({ name: 'c.com', autoRenew: false, renewalPrice: null, registrar: 'Namecheap' }),
      domain({ name: 'd.com', autoRenew: true, renewalPrice: 5, promoPrice: 4, expires: '2027-01-01' }),
    ],
  }
  const summary = summarize(data, { today: TODAY, dueWithinDays: 90 })
  assert.equal(summary.count, 4)
  assert.equal(summary.unpriced, 1)
  assert.equal(summary.totalAnnual, 35)
  assert.deepEqual(summary.autoRenew.on, { count: 2, annual: 15 })
  assert.deepEqual(summary.autoRenew.off, { count: 1, annual: 20 })
  assert.equal(summary.totalAnnualAtPromo, 34)
  assert.equal(summary.byRegistrar.find((row) => row.registrar === 'Namecheap').unpriced, 1)
  assert.deepEqual(summary.dueSoon.map((row) => row.name), ['d.com'])
})

test('expired domains are reported separately from upcoming ones', () => {
  const data = { version: 1, updatedAt: new Date().toISOString(), domains: [domain({ name: 'old.com', expires: '2026-01-01' })] }
  const summary = summarize(data, { today: TODAY })
  assert.equal(summary.expired.length, 1)
  assert.equal(summary.dueSoon.length, 0)
  assert.ok(summary.expired[0].daysLeft < 0)
})

test('daysLeft is calendar based', () => {
  assert.equal(daysLeft('2026-11-08', TODAY), 0)
  assert.equal(daysLeft('2026-11-18', TODAY), 10)
  assert.equal(daysLeft('2026-11-07', TODAY), -1)
})

test('staleness flags old syncs and ignores manual domains', () => {
  const data = {
    version: 1,
    updatedAt: new Date().toISOString(),
    domains: [
      domain({ name: 'fresh.com', syncedAt: '2026-11-06T10:00:00Z', source: 'cloudflare' }),
      domain({ name: 'old.com', syncedAt: '2026-01-01T00:00:00Z', source: 'cloudflare' }),
      domain({ name: 'manual.com', syncedAt: null, source: 'manual' }),
    ],
  }
  const summary = summarize(data, { today: TODAY, staleAfterDays: 14 })
  assert.deepEqual(
    {
      syncedCount: summary.staleness.syncedCount,
      neverSyncedCount: summary.staleness.neverSyncedCount,
      staleCount: summary.staleness.staleCount,
      staleAfterDays: summary.staleness.staleAfterDays,
    },
    { syncedCount: 2, neverSyncedCount: 1, staleCount: 1, staleAfterDays: 14 },
  )
  assert.equal(summary.staleness.staleDomains[0].name, 'old.com')
  assert.ok(summary.staleness.staleDomains[0].daysSinceSync > 14)
  assert.ok(summary.staleness.oldestSyncedAt.startsWith('2026-01-01'))
  assert.ok(summary.staleness.newestSyncedAt.startsWith('2026-11-06'))

  // a fresher threshold makes the same data stale
  assert.equal(summarize(data, { today: TODAY, staleAfterDays: 1 }).staleness.staleCount, 2)
  // nothing stale when every sync is recent
  assert.equal(summarize(data, { today: TODAY, staleAfterDays: 400 }).staleness.staleCount, 0)
})

test('round2 avoids floating point dust', () => {
  assert.equal(round2(0.1 + 0.2), 0.3)
})

test('normalizeDomain keeps an optional ICANN fee and rejects negatives', () => {
  const base = { name: 'example.com', registrar: 'Namecheap', expires: '2027-03-15', autoRenew: false, renewalPrice: 45.48 }
  assert.equal(normalizeDomain({ ...base, icannFee: 0.2 }).icannFee, 0.2)
  assert.equal(normalizeDomain(base).icannFee, null)
  assert.throws(() => normalizeDomain({ ...base, icannFee: -0.2 }), /icannFee/)
})

test('summary folds registrar-collected ICANN fees into an all-in total', () => {
  const data = {
    version: 1,
    updatedAt: new Date().toISOString(),
    domains: [
      domain({ name: 'a.com', registrar: 'Namecheap', renewalPrice: 10, icannFee: 0.2 }),
      domain({ name: 'b.com', registrar: 'Namecheap', renewalPrice: 20, promoPrice: 18, icannFee: 0.2 }),
      domain({ name: 'c.id', registrar: 'Namecheap', renewalPrice: 25.98 }),
    ],
  }
  const summary = summarize(data, { today: TODAY })
  assert.equal(summary.icannFeesAnnual, 0.4)
  assert.equal(summary.totalAnnual, 55.98)
  assert.equal(summary.totalAnnualAtPromo, 53.98)
  assert.equal(summary.totalAnnualWithFees, 56.38)
  assert.equal(summary.totalAnnualAtPromoWithFees, 54.38)
  assert.equal(summary.byRegistrar.find((row) => row.registrar === 'Namecheap').icannFeesAnnual, 0.4)
})

test('saving normalizes and sorts a copy without mutating the caller', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-copy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = { ...emptyData(), domains: [domain({ name: 'Z.COM' }), domain({ name: 'a.com' })] }
  const original = structuredClone(data)
  const saved = await saveData(join(dir, 'domains.json'), data)
  assert.deepEqual(data, original)
  assert.deepEqual(saved.domains.map((row) => row.name), ['a.com', 'z.com'])
})

test('atomic files and newly created directories have owner-only permissions', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-private-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const parent = join(dir, 'private')
  const file = join(parent, 'domains.json')
  await saveData(file, emptyData())
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(parent)).mode & 0o777, 0o700)
  assert.deepEqual(await readdir(parent), ['domains.json'])
})

test('failed atomic replacements clean up temporary files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-cleanup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const destination = join(dir, 'directory')
  await mkdir(destination)
  await assert.rejects(() => writeFileAtomic(destination, 'portfolio'), /EISDIR|EPERM|EACCES/)
  assert.deepEqual(await readdir(dir), ['directory'])
})

test('atomic writes replace a destination symlink without modifying its target', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-domain-manager-symlink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = join(dir, 'target.txt')
  const destination = join(dir, 'portfolio.md')
  await writeFile(target, 'kept', 'utf8')
  await symlink(target, destination)
  await writeFileAtomic(destination, 'portfolio')
  assert.equal(await readFile(target, 'utf8'), 'kept')
  assert.equal(await readFile(destination, 'utf8'), 'portfolio')
})
