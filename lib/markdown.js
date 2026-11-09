/**
 * Markdown interop: parse portfolio tables from a markdown document and render the
 * portfolio back out. Pure functions only — no file system, no network.
 *
 * Recognised table columns (header names, case-insensitive): Domain, Registrar,
 * Purpose, Group, Renewal Price, Currency, Expires, Auto-renew, Notes.
 * Only Domain and Expires are required; unrelated tables are ignored.
 */
import { round2, summarize } from './store.js'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const SEPARATOR_RE = /^\|[\s:|-]+\|$/

function splitRow(line) {
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cell = ''
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\' && source[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (source[index] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += source[index]
    }
  }
  cells.push(cell.trim())
  return cells
}

function parseDateCell(value) {
  const trimmed = (value ?? '').trim()
  const iso = trimmed.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const named = trimmed.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{4})/)
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase())
    if (month >= 0) return `${named[3]}-${String(month + 1).padStart(2, '0')}-${String(named[2]).padStart(2, '0')}`
  }
  return null
}

function parsePriceCell(value) {
  const cell = value ?? ''
  const price = cell.match(/^\s*\$\s*([0-9]+(?:\.[0-9]+)?)/)
  const promo = cell.match(/promo[^$]*\$\s*([0-9]+(?:\.[0-9]+)?)/i)
  const fee = cell.match(/\+\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*ICANN/i)
  const note = (cell.match(/\*\(([^)]+)\)\*/) ?? [])[1]
  const noteText = note !== undefined && !/^promo/i.test(note) ? note.trim() : null
  return {
    renewalPrice: price ? Number(price[1]) : null,
    promoPrice: promo ? Number(promo[1]) : null,
    icannFee: fee ? Number(fee[1]) : null,
    note: noteText,
  }
}

function columnMap(header) {
  const keys = header.map((cell) => cell.toLowerCase().replace(/\s+/g, ' '))
  const find = (predicate) => keys.findIndex(predicate)
  return {
    name: find((key) => key === 'domain' || key === 'domain name'),
    registrar: find((key) => key === 'registrar'),
    purpose: find((key) => key === 'purpose'),
    group: find((key) => key === 'group'),
    price: find((key) => key.includes('renewal price') || key.includes('price')),
    currency: find((key) => key === 'currency'),
    expires: find((key) => key === 'expires' || key === 'expiry' || key === 'expiration'),
    autoRenew: find((key) => key.startsWith('auto')),
    notes: find((key) => key === 'notes' || key === 'note'),
  }
}

/**
 * Parse portfolio tables from a markdown document.
 * @param {string} markdown
 * @returns {{domains: object[], skipped: string[]}}
 */
export function parseDomainsMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/)
  const domains = []
  const skipped = []
  let h2 = ''
  let h3 = ''

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      h2 = line.slice(3).trim()
      h3 = ''
      continue
    }
    if (line.startsWith('### ')) {
      h3 = line.slice(4).trim()
      continue
    }
    if (!line.startsWith('|')) continue
    if (i + 1 >= lines.length || !SEPARATOR_RE.test(lines[i + 1].trim())) continue

    const header = splitRow(line)
    const cols = columnMap(header)
    if (cols.name === -1 || cols.expires === -1) {
      skipped.push(header.join(' | '))
      i += 1
      continue
    }

    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j += 1) {
      const row = splitRow(lines[j])
      const name = (row[cols.name] ?? '').toLowerCase()
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(name)) continue
      const expires = parseDateCell(row[cols.expires])
      if (!expires) {
        skipped.push(`row ${name}: unreadable expiry "${row[cols.expires] ?? ''}"`)
        continue
      }
      const price = cols.price >= 0 ? parsePriceCell(row[cols.price]) : { renewalPrice: null, promoPrice: null, note: null }
      const registrarCell = cols.registrar >= 0 ? (row[cols.registrar] ?? '').trim() : ''
      const registrar = registrarCell || guessRegistrar(h2, h3)
      const purpose = cols.purpose >= 0 ? cleanText(row[cols.purpose]) : null
      const group = cols.group >= 0 ? cleanText(row[cols.group]) : null
      const notesCell = cols.notes >= 0 ? cleanText(row[cols.notes]) : null
      const notes = [notesCell, price.note].filter(Boolean).join('; ') || null
      const autoRenewCell = cols.autoRenew >= 0 ? (row[cols.autoRenew] ?? '').toLowerCase() : ''
      domains.push({
        name,
        registrar: registrar || 'unknown',
        expires,
        autoRenew: /^(yes|true|on|enabled)$/.test(autoRenewCell),
        renewalPrice: price.renewalPrice,
        currency: cols.currency >= 0 ? (row[cols.currency] ?? '').trim() || 'USD' : 'USD',
        promoPrice: price.promoPrice,
        ...(price.icannFee !== null && price.icannFee !== undefined ? { icannFee: price.icannFee } : {}),
        purpose,
        group,
        notes,
        source: 'markdown-import',
        syncedAt: null,
      })
    }
    i += 1
  }
  return { domains, skipped }
}

function cleanText(value) {
  const text = (value ?? '').replace(/^-\s*$/, '').trim()
  return text.length === 0 ? null : text
}

function guessRegistrar(h2, h3) {
  const headings = `${h2} ${h3}`.toLowerCase()
  if (headings.includes('cloudflare')) return 'Cloudflare'
  if (headings.includes('namecheap')) return 'Namecheap'
  return 'unknown'
}

function money(value) {
  return `$${value.toFixed(2)}`
}

function priceCell(domain) {
  const parts = [typeof domain.renewalPrice === 'number' ? `${money(domain.renewalPrice)}/year` : 'unknown']
  if (typeof domain.icannFee === 'number') parts.push(`+ ${money(domain.icannFee)} ICANN`)
  if (typeof domain.promoPrice === 'number') parts.push(`*(promo: ${money(domain.promoPrice)})*`)
  return parts.join(' ')
}

function escapeCell(value) {
  return value === null || value === undefined ? '-' : String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * Render the portfolio as a markdown document grouped by registrar, with totals and
 * an auto-renewal cost split.
 * @param {{domains: object[]}} data
 * @param {{asOf?: string, title?: string, dueWithinDays?: number}} [options]
 */
export function renderDomainsMarkdown(data, { asOf, title = 'Domain Portfolio', dueWithinDays = 90, staleAfterDays = 14 } = {}) {
  const today = asOf ? new Date(`${asOf}T12:00:00`) : new Date()
  const summary = summarize(data, { today, dueWithinDays, staleAfterDays })
  const registrars = [...new Set(data.domains.map((domain) => domain.registrar))].sort()
  const out = [`# ${title}`, '']
  out.push(
    `_Generated from the local domain store (as of ${summary.asOf}). Prices are per-year renewal prices; ` +
      `expiry dates are the registrar dates. ${summary.count} domains` +
      (summary.unpriced > 0 ? `, ${summary.unpriced} without a recorded price` : '') +
      '._',
    '',
  )
  if (summary.staleness.staleCount > 0) {
    out.push(
      `_Data may be stale: ${summary.staleness.staleCount} domain(s) not synced in more than ${summary.staleness.staleAfterDays} days` +
        ` (oldest sync: ${summary.staleness.oldestSyncedAt?.slice(0, 10) ?? 'unknown'}). Run a registrar sync to refresh._`,
      '',
    )
  }

  for (const registrar of registrars) {
    const rows = data.domains
      .filter((domain) => domain.registrar === registrar)
      .sort((a, b) => a.name.localeCompare(b.name))
    out.push(`## ${registrar} (${rows.length} domains)`, '')
    out.push('| Domain | Registrar | Purpose | Group | Renewal Price | Currency | Expires | Auto-renew | Notes |')
    out.push('|--------|-----------|---------|-------|---------------|----------|---------|------------|-------|')
    for (const domain of rows) {
      out.push(
        `| ${escapeCell(domain.name)} | ${escapeCell(domain.registrar)} | ${escapeCell(domain.purpose)} | ${escapeCell(domain.group)} | ${priceCell(domain)} | ${escapeCell(domain.currency ?? 'USD')} | ${domain.expires} | ${domain.autoRenew ? 'yes' : 'no'} | ${escapeCell(domain.notes)} |`,
      )
    }
    const subtotal = summary.byRegistrar.find((entry) => entry.registrar === registrar)
    out.push('', `**${registrar} subtotal: ${money(subtotal.annual)}/year**${subtotal.unpriced > 0 ? ` *(${subtotal.unpriced} unpriced)*` : ''}`, '')
  }

  out.push(`**Total annual renewal cost: ${money(summary.totalAnnual)}/year**`)
  if (summary.icannFeesAnnual > 0) {
    out.push(
      `**ICANN fees collected by the registrar: +${money(summary.icannFeesAnnual)}/year — all-in renewal cost ${money(summary.totalAnnualWithFees)}/year**`,
    )
  }
  if (summary.promotion.length > 0) {
    out.push(
      `*(or ${money(summary.totalAnnualAtPromo)}/year at current promo prices: ${summary.promotion
        .map((domain) => `${domain.name} ${money(domain.promoPrice)}`)
        .join(', ')})*`,
    )
  }
  out.push('')

  out.push('## Annual Cost by Auto-Renewal', '')
  out.push('| Auto-renew | Domains | Yearly cost |', '|------------|---------|-------------|')
  out.push(`| Enabled | ${summary.autoRenew.on.count} | **${money(summary.autoRenew.on.annual)}** |`)
  out.push(`| Disabled | ${summary.autoRenew.off.count} | **${money(summary.autoRenew.off.annual)}** |`)
  out.push(`| All (priced) | ${summary.autoRenew.on.count + summary.autoRenew.off.count} | **${money(summary.totalAnnual)}** |`, '')
  out.push(
    `Auto-renew enabled costs ${money(summary.autoRenew.on.annual)}/year without action; ` +
      `${money(summary.autoRenew.off.annual)}/year needs manual renewal.`,
    '',
  )

  const manual = data.domains.filter((domain) => !domain.autoRenew).map((domain) => domain.name).sort()
  if (manual.length > 0) out.push(`Manual-renewal domains: ${manual.join(', ')}.`, '')
  if (summary.dueSoon.length > 0) {
    out.push(
      `Expiring within ${summary.dueWithinDays} days: ${summary.dueSoon
        .map((domain) => `${domain.name} (${domain.expires})`)
        .join(', ')}.`,
      '',
    )
  }
  if (summary.expired.length > 0) {
    out.push(`Already expired: ${summary.expired.map((domain) => `${domain.name} (${domain.expires})`).join(', ')}.`, '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

export { round2 }
