import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findDomain, isTransferActive, loadData, saveData, updateDomain } from './store.js'
import { HttpError, redact } from './http.js'
import * as cloudflare from './registrars/cloudflare.js'

export const transferSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string' }, to: { type: 'string' }, state: { type: 'string' },
    accountId: { type: 'string' }, quoteId: { type: 'string' },
    checkedAt: { type: 'string' }, updatedAt: { type: 'string' },
    autoRenew: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    transferPrice: { type: 'number' }, renewalPrice: { type: 'number' },
    currency: { type: 'string' }, message: { type: 'string' },
  },
}

/** Short, human labels for the transfer state machine (raw state stays in JSON). */
const STATE_LABELS = {
  ready: 'ready to submit',
  ineligible: 'not eligible yet',
  submitting: 'submission outcome unknown',
  pending: 'submitted, waiting for the losing registrar',
  in_progress: 'submitted, transfer in progress',
  action_required: 'submitted, action required',
  blocked: 'submitted, blocked',
  succeeded: 'succeeded',
  failed: 'failed',
}

/**
 * Human-readable label for a stored transfer. `blocked` transfers carry the
 * registry detail in `message`, so distinguish the common "awaiting approval"
 * stage from a generic block.
 */
export function transferStateLabel(transfer) {
  if (!transfer) return 'unknown'
  if (transfer.state === 'blocked' && /awaiting_approval/.test(String(transfer.message ?? ''))) {
    return 'submitted, awaiting approval'
  }
  return STATE_LABELS[transfer.state] ?? transfer.state
}

/**
 * Plain-language explanation for Cloudflare transfer-check reason codes.
 * Unknown codes still render with the raw code, so nothing is hidden.
 */
const REASON_GUIDANCE = {
  domain_locked: 'Unlock the domain at Namecheap (Domain List → Manage → Sharing & Transfer) before retrying.',
  domain_not_exists: 'No registration was found; verify the domain name and its registration at Namecheap.',
  domain_on_cloudflare: 'Cloudflare is already the registrar; sync its registration instead of submitting another transfer.',
  registry_status: 'The registry reports a status that blocks transfer; resolve pending transfers or holds with Namecheap before retrying.',
  domain_outside_transfer_window: 'The domain is in a transfer waiting period; check recent registration, transfer or registrant-contact changes before retrying.',
  domain_max_term: 'The transfer would exceed the registry maximum registration term; wait or contact Namecheap support.',
  invalid_auth_code: 'The EPP/authorization code was rejected; request a fresh code from Namecheap and run the check again.',
  invalid_auth_code_format: 'Pass the raw EPP/authorization code, not a pre-encoded value; the plugin encodes it for Cloudflare.',
  domain_premium: 'Premium domains need the Cloudflare dashboard to finish the transfer; the API cannot complete them.',
  extension_not_supported_via_api: 'Use the Cloudflare dashboard for this extension; the transfer API does not support it.',
  extension_not_supported: 'Cloudflare Registrar does not support this extension.',
  extension_disallows_transfer: 'This extension currently disallows transfers; check registry requirements before retrying.',
  invalid_zone_plan: 'The zone plan does not meet transfer requirements; review its full-setup configuration in Cloudflare.',
  domain_unsupported: 'Cloudflare rejected the domain format; verify the fully qualified domain name.',
  client_transfer_prohibited: 'The domain carries a clientTransferProhibited lock; remove the transfer lock at Namecheap.',
  registry_lock: 'The registry holds the domain; resolve the hold with the registry or Namecheap support.',
  pending_transfer: 'A transfer for this domain is already pending; wait for it to finish (or cancel it) before starting another.',
  auth_code_invalid: 'The EPP/authorization code was rejected; request a fresh code from Namecheap and run the check again.',
  auth_code_missing: 'Pass the raw Namecheap EPP/authorization code as authCode.',
  expiration_too_soon: 'Renew the domain at Namecheap first — transfers cannot start close to expiry.',
  expired: 'Restore the expired domain at Namecheap first.',
  registration_too_new: 'Registrations are locked for 60 days after creation; wait and retry.',
  transfer_too_new: 'A previous transfer or registrant change triggers a 60-day lock; wait and retry.',
  zone_not_found:
    'No Cloudflare zone exists for this domain yet. In the Cloudflare dashboard use Add a site → this domain, then point the registrar nameservers at the assigned pair — Cloudflare rejects transfer-ins without an Active zone.',
  zone_not_active:
    'The Cloudflare zone is not Active yet, so a transfer request would be rejected. Point the registrar nameservers at the zone\'s assigned pair and wait for Active (usually minutes, up to 24h), then check again.',
  zone_status_invalid: 'The Cloudflare zone must be an Active, full-setup zone before the transfer can start.',
  dnssec_enabled: 'Remove the existing DNSSEC/DS records at the current DNS provider and let them expire before transferring; re-enable DNSSEC in Cloudflare after completion.',
  dnssec_already_enabled: 'Remove the existing DNSSEC/DS records at the current DNS provider and let them expire before transferring; re-enable DNSSEC in Cloudflare after completion.',
  premium_transfer: 'Premium domains need the Cloudflare dashboard to finish the transfer; the API cannot complete them.',
  premium_domain: 'Premium domains need the Cloudflare dashboard to finish the transfer; the API cannot complete them.',
  unsupported_tld: 'Cloudflare Registrar does not support transfers for this TLD.',
  tld_not_supported: 'Cloudflare Registrar does not support transfers for this TLD.',
  insufficient_funds: 'Fix the default payment method in the Cloudflare dashboard, then retry.',
  payment_required: 'Fix the default payment method in the Cloudflare dashboard, then retry.',
}
const REASON_FALLBACK = 'Address this Cloudflare-reported blocker, then run domain_manager_transfer_check again.'

export function explainReasons(reasons = []) {
  return reasons.map((code) => `${code}: ${REASON_GUIDANCE[code] ?? REASON_FALLBACK}`)
}

/** Pull the Cloudflare error code out of a workflow message such as "zone_not_active: ...". */
function failedCode(message) {
  const match = /^([a-z][a-z0-9_]*)\s*:/.exec(String(message ?? ''))
  return match ? match[1] : null
}

const DNS_STEP =
  'Before anything else, confirm DNS is already served by Cloudflare: back up every website and email record, disable old DNSSEC/DS records and let propagation finish. Cloudflare Registrar needs an Active full-setup zone, and the transfer never migrates DNS for you.'

/** State-aware next steps: only show what matters right now. */
export function transferSteps(transfer) {
  const message = String(transfer?.message ?? '')
  switch (transfer?.state) {
    case 'ready':
      return [
        DNS_STEP,
        'Remind the user that transferring may extend the registration by one year and bill for that additional year at the new registrar as part of the quoted transfer fee, even if auto-renew is off. Registry rules and zero-fee exceptions apply.',
        'Ask the user the confirmationPrompt and wait for explicit approval of the domain, fee, possible extra year, yearly renewal price and auto-renew choice. A request to check or prepare the transfer is not approval.',
        'Only after that explicit approval, call domain_manager_transfer_start with this quoteId, confirm: true and the same authCode. Nothing has been charged yet.',
      ]
    case 'ineligible':
      return [
        'Fix every blocker listed above — nothing was submitted and nothing was charged.',
        'Run domain_manager_transfer_check again once it is fixed; that returns a fresh quote.',
        'Get explicit user approval of the new quote before calling domain_manager_transfer_start.',
      ]
    case 'submitting':
      return [
        'Do not resubmit: the request may already have reached Cloudflare.',
        'Run domain_manager_transfer_status to reconcile, and confirm the transfer in the Cloudflare dashboard.',
      ]
    case 'pending':
      return [
        'Cloudflare accepted the request. Transfers usually need approval from the losing registrar or the registrant before they complete.',
        'Run domain_manager_transfer_status again later (hours to a few days). No other action is needed unless a step appears above.',
      ]
    case 'in_progress':
      return ['The registry is moving the domain. Keep DNS served by Cloudflare and run domain_manager_transfer_status again later.']
    case 'action_required':
      return [
        'Complete the action Cloudflare reported above (for example approve the transfer authorization email), then run domain_manager_transfer_status again.',
      ]
    case 'blocked': {
      const guidance = REASON_GUIDANCE[failedCode(message)]
      if (/awaiting_approval/.test(message)) {
        return [
          guidance ??
            'The transfer is waiting for approval — normally an email sent to the domain\'s registrant contact (check the admin mailbox and spam). Approve it, or ask the losing registrar for an expedited release.',
          'Some transfers auto-release after about 5 days, but timing depends on the registry and any holds; check the dashboard rather than assuming release.',
          'Run domain_manager_transfer_status again later; nothing else is needed.',
        ]
      }
      return [
        ...(guidance ? [guidance] : []),
        'The transfer is blocked until the losing registrar or registry responds. Check the Cloudflare dashboard and run domain_manager_transfer_status again later.',
      ]
    }
    case 'failed': {
      const guidance = REASON_GUIDANCE[failedCode(message)]
      return [
        ...(guidance ? [guidance] : []),
        'The transfer did not complete and is not retried automatically.',
        'Confirm the domain\'s current state in the Cloudflare dashboard, then run a new domain_manager_transfer_check and obtain fresh user approval before any retry.',
      ]
    }
    case 'succeeded':
      return [
        'The registrar, expiry and renewal price in the portfolio were refreshed from Cloudflare. No further transfer action is needed.',
        'If this extension uses DNSSEC, re-enable it in the Cloudflare dashboard now.',
      ]
    default:
      return ['Run domain_manager_transfer_check to inspect this transfer.']
  }
}

function extensionReminder(transfer) {
  const extension = `The transfer may extend your registration by one year at ${transfer.to}.`
  return transfer.transferPrice === 0
    ? `${extension} The quoted transfer fee is 0 ${transfer.currency}; zero-fee extensions are not charged. Extension rules vary by registry.`
    : `${extension} The new registrar may bill for that additional year as part of the quoted transfer fee, even if auto-renew is off. Extension rules vary by registry.`
}

/** Describe billing rules without claiming a payment was independently verified. */
function chargeLine(transfer) {
  const price = typeof transfer.transferPrice === 'number' ? `${transfer.transferPrice} ${transfer.currency}` : 'the quoted fee'
  const renewal = typeof transfer.renewalPrice === 'number' ? `${transfer.renewalPrice} ${transfer.currency}/year` : 'the quoted renewal price'
  const renew = `renewal ${renewal}; auto-renew ${transfer.autoRenew ? 'on' : 'off'}`
  switch (transfer.state) {
    case 'ready':
      return `Billing: nothing charged by this check. Successful completion normally charges ${price} once (non-refundable); zero-fee extensions are not charged. ${extensionReminder(transfer)} Expiry extensions depend on registry rules; ${renew}.`
    case 'ineligible':
      return 'Billing: nothing was submitted and nothing was charged.'
    case 'submitting':
      return 'Billing: the request may have reached Cloudflare; confirm before retrying.'
    case 'failed':
      return 'Billing: no transfer completed. Confirm in the Cloudflare dashboard whether any fee was charged before retrying.'
    case 'succeeded':
      return `Billing: Cloudflare reports successful completion; the quoted fee is ${price} (non-refundable when charged). Verify payment in the dashboard and use the refreshed portfolio expiry; ${renew}.`
    default:
      return `Billing: the non-refundable ${price} transfer fee applies to this submitted transfer; ${renew}.`
  }
}

function result(domain) {
  const transfer = domain.transfer
  return {
    name: domain.name,
    transfer,
    explanation: explainReasons(transfer.reasons ?? []),
    steps: transferSteps(transfer),
    ...(transfer.state === 'ready' ? {
      confirmationPrompt:
        `${extensionReminder(transfer)} Do you explicitly confirm transferring ${domain.name} from ${transfer.from} to ${transfer.to} ` +
        `for the quoted non-refundable transfer fee of ${transfer.transferPrice} ${transfer.currency}, ` +
        `with annual renewal at ${transfer.renewalPrice} ${transfer.currency}/year and auto-renew ${transfer.autoRenew ? 'on' : 'off'}?`,
    } : {}),
  }
}

function output() {
  return {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' }, transfer: transferSchema,
        explanation: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
        confirmationPrompt: { type: 'string', description: 'For a ready quote, ask the user this question and wait for explicit approval before calling transfer_start.' },
      },
    },
    render: (_args, value) => {
      const transfer = value.transfer
      const lines = [`${value.name}: ${transfer.from} -> ${transfer.to}, ${transferStateLabel(transfer)}`]
      if (typeof transfer.transferPrice === 'number') {
        lines.push(`Transfer: ${transfer.transferPrice} ${transfer.currency}; renewal: ${transfer.renewalPrice} ${transfer.currency}/year; auto-renew ${transfer.autoRenew ? 'on' : 'off'}.`)
      }
      if (transfer.reasons?.length) lines.push(`Blocked by: ${transfer.reasons.join(', ')}`)
      if (transfer.state === 'ready') {
        lines.push(`Quote ID: ${transfer.quoteId} (valid until eligibility or pricing changes).`)
      }
      lines.push('', chargeLine(transfer))
      if ((transfer.state === 'ready' || transfer.state === 'ineligible') && transfer.warnings?.length) {
        lines.push('', 'Heads-up:')
        lines.push(...transfer.warnings.map((warning) => `- ${warning}`))
      }
      if (value.explanation?.length) {
        lines.push('', 'Why blocked:')
        lines.push(...value.explanation.map((entry) => `- ${entry}`))
      }
      if (transfer.message) lines.push('', `Cloudflare detail: ${transfer.message}`)
      if (value.confirmationPrompt) lines.push('', 'Confirmation required — ask the user and wait:', value.confirmationPrompt)
      lines.push('', 'Next steps:', ...value.steps.map((step, index) => `${index + 1}. ${step}`))
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }
}

function requireDomain(data, name) {
  const domain = findDomain(data, name)
  if (!domain) throw new Error(`unknown domain: ${name} (sync or add it before transferring)`)
  return domain
}

function requireSource(domain) {
  if (domain.registrar.toLowerCase() !== 'namecheap') throw new Error('Only Namecheap -> Cloudflare transfers are supported')
}

function requireAccount(transfer, config) {
  if (transfer.accountId !== config.accountId) throw new Error('Transfer belongs to a different Cloudflare account; restore the original account configuration')
}

function quote(domain, checked, config, autoRenew, warnings = []) {
  const now = new Date().toISOString()
  const { transferable, ...details } = checked
  return {
    from: 'Namecheap', to: 'Cloudflare', accountId: config.accountId,
    state: transferable ? 'ready' : 'ineligible', quoteId: randomUUID(),
    checkedAt: now, updatedAt: now, autoRenew: autoRenew ?? domain.autoRenew,
    ...(warnings.length ? { warnings } : {}), ...details,
  }
}

/** True when a fresh check produced exactly the quote the user is already holding. */
function sameReadyQuote(previous, next) {
  return Boolean(
    previous?.state === 'ready' && next.state === 'ready' &&
    previous.accountId === next.accountId &&
    previous.transferPrice === next.transferPrice &&
    previous.renewalPrice === next.renewalPrice &&
    previous.currency === next.currency &&
    previous.autoRenew === next.autoRenew,
  )
}

/**
 * Best-effort zone readiness warning. A transfer-in submitted while the zone is
 * missing or still pending is rejected by Cloudflare, so surface that before the
 * user approves a charge. Lookup failures remain visible as advisory warnings.
 */
async function zoneWarnings(config, name) {
  let zone
  try {
    zone = await cloudflare.getZoneStatus(config, name)
  } catch (error) {
    return [`Cloudflare zone readiness could not be verified: ${safeError(error, undefined, config.apiToken)}. Check the target account's zone manually; Zone read permission is required for this advisory lookup.`]
  }
  if (!zone.found) {
    return [
      'No Cloudflare zone found for this domain. Cloudflare rejects a transfer-in until the domain is an Active zone: add it in the dashboard (Add a site) and point the registrar nameservers at the assigned pair. The plugin cannot create zones with its registrar-only token.',
    ]
  }
  if (zone.status !== 'active') {
    const servers = zone.nameservers.length ? ` (assigned: ${zone.nameservers.join(' / ')})` : ''
    return [
      `The Cloudflare zone is "${zone.status}", not "active"${servers}. A transfer submitted before it activates is rejected without creating a transfer; point the registrar nameservers at the assigned pair and wait for Active (minutes to ~24h), then check again.`,
    ]
  }
  return []
}

function safeError(error, authCode, apiToken) {
  const secrets = [apiToken]
  if (typeof authCode === 'string') secrets.push(authCode, Buffer.from(authCode, 'utf8').toString('base64'))
  return redact(error?.message ?? String(error), secrets)
}

export function registerTransferTools(ctx, { dataFile, withStore, cloudflareConfig }) {
  async function persist(data, domain, transfer, patch = {}) {
    const next = updateDomain(data, domain.name, { ...patch, transfer })
    await saveData(dataFile, next)
    return result(findDomain(next, domain.name))
  }

  async function complete(data, domain, transfer) {
    if (transfer.state !== 'succeeded') return persist(data, domain, transfer)
    const registration = await cloudflare.getRegistration(cloudflareConfig, domain.name)
    return persist(data, domain, transfer, {
      registrar: 'Cloudflare', expires: registration.expires, autoRenew: registration.autoRenew,
      renewalPrice: transfer.renewalPrice, currency: transfer.currency,
      promoPrice: null, icannFee: null, source: 'cloudflare', syncedAt: new Date().toISOString(),
    })
  }

  const register = (definition) => {
    const execute = definition.execute
    ctx.tools.register(defineTool({
      ...definition,
      async execute(args) {
        try {
          return await withStore(() => execute(args))
        } catch (error) {
          throw new Error(safeError(error, args.authCode, cloudflareConfig.apiToken))
        }
      },
    }))
  }

  register({
    name: 'domain_manager_transfer_check',
    description: 'Read-only registrar eligibility/pricing check for a stored Namecheap domain transferring to Cloudflare. Persists a quote, explains blockers, warns about zone readiness and possible billing for an additional registration year, and keeps the quote ID when nothing changed. For a ready quote, ask the user the returned confirmationPrompt and wait for explicit approval before transfer_start. Does NOT transfer or charge. Auth codes are not saved by this plugin; the host may log tool arguments.',
    parameters: {
      name: { type: 'string', required: true, description: 'Domain in the portfolio, currently at Namecheap.' },
      toRegistrar: { type: 'string', description: 'Destination registrar; only cloudflare is supported (default).' },
      authCode: { type: 'string', description: 'Raw Namecheap EPP code, not base64. Required except for .uk domains.' },
      autoRenew: { type: 'boolean', description: 'Auto-renew after transfer; defaults to the current portfolio setting. Included in the confirmed quote.' },
    },
    output: output(),
    async execute(args) {
      if (String(args.toRegistrar ?? 'cloudflare').trim().toLowerCase() !== 'cloudflare') throw new Error('Only Namecheap -> Cloudflare transfers are supported')
      if (args.autoRenew !== undefined && typeof args.autoRenew !== 'boolean') throw new Error('autoRenew must be a boolean')
      const data = await loadData(dataFile)
      const domain = requireDomain(data, args.name)
      requireSource(domain)
      if (isTransferActive(domain.transfer)) throw new Error('Transfer already submitted or outcome unknown; use domain_manager_transfer_status before retrying')
      const checked = await cloudflare.checkTransfer(cloudflareConfig, domain.name, args.authCode)
      let warnings = await zoneWarnings(cloudflareConfig, domain.name)
      if ((checked.reasons ?? []).some((code) => code.startsWith('zone_'))) {
        warnings = warnings.filter((warning) => !/^No Cloudflare zone found|^The Cloudflare zone is /.test(warning))
      }
      const next = quote(domain, checked, cloudflareConfig, args.autoRenew, warnings)
      if (sameReadyQuote(domain.transfer, next)) {
        next.quoteId = domain.transfer.quoteId
        next.message = 'Quote unchanged since the previous check; the existing quote ID is still valid for confirmation.'
      } else if (domain.transfer?.state === 'ready' && next.state === 'ready') {
        next.message = 'The previous quote changed (prices or settings differ); the old quote ID is no longer valid.'
      }
      return persist(data, domain, next)
    },
  })

  register({
    name: 'domain_manager_transfer_start',
    description: 'BILLABLE, NON-REFUNDABLE: before submitting, remind the user that this transfer may extend registration by one year and bill for that additional year at Cloudflare as part of the quoted transfer fee, even if auto-renew is off (registry rules and zero-fee exceptions apply). Ask the confirmationPrompt from transfer_check and WAIT for explicit user approval of that warning, domain, fee, renewal price and auto-renew setting. Never infer approval from a request to check or prepare a transfer. Requires confirm=true and that quoteId. Rechecks eligibility/prices; never changes DNS or unlocks domains.',
    parameters: {
      name: { type: 'string', required: true, description: 'Domain to transfer.' },
      quoteId: { type: 'string', required: true, description: 'Quote ID returned by domain_manager_transfer_check and approved by the user.' },
      confirm: { type: 'boolean', required: true, description: 'Set true only after reminding the user of the possible one-year extension and additional-year billing, asking the confirmationPrompt, and receiving explicit approval. Otherwise do not submit.' },
      authCode: { type: 'string', description: 'Raw Namecheap EPP/authorization code again (not stored); omit for .uk.' },
    },
    output: output(),
    async execute(args) {
      if (args.confirm !== true) {
        throw new Error('Explicit user confirmation (confirm=true) is required: remind the user that the transfer may extend registration by one year and bill for another year at the new registrar, even if auto-renew is off (registry rules and zero-fee exceptions apply). Ask the confirmationPrompt from domain_manager_transfer_check and wait for explicit approval before submitting.')
      }
      const data = await loadData(dataFile)
      const domain = requireDomain(data, args.name)
      requireSource(domain)
      const transfer = domain.transfer
      if (isTransferActive(transfer)) throw new Error('Transfer already submitted or outcome unknown; use domain_manager_transfer_status, not another start')
      if (transfer?.state !== 'ready' || !args.quoteId || args.quoteId !== transfer.quoteId) {
        throw new Error('Run domain_manager_transfer_check and confirm its current ready quote before starting')
      }
      requireAccount(transfer, cloudflareConfig)
      const checked = await cloudflare.checkTransfer(cloudflareConfig, domain.name, args.authCode)
      if (
        !checked.transferable || checked.transferPrice !== transfer.transferPrice ||
        checked.renewalPrice !== transfer.renewalPrice || checked.currency !== transfer.currency
      ) {
        const warnings = await zoneWarnings(cloudflareConfig, domain.name)
        await persist(data, domain, quote(domain, checked, cloudflareConfig, transfer.autoRenew, warnings))
        const detail = checked.transferable
          ? ''
          : ` (${explainReasons(checked.reasons ?? []).join('; ')})`
        throw new Error(
          `Nothing was submitted and nothing was charged: Cloudflare no longer quotes this transfer as approved${detail}. ` +
            'Its eligibility or pricing changed, so the quote was refreshed — run domain_manager_transfer_check again and obtain fresh user confirmation.',
        )
      }
      // Persist intent first: a timeout or crash after POST must not permit an automatic resubmission.
      const submitting = { ...transfer, state: 'submitting', warnings: undefined, updatedAt: new Date().toISOString() }
      await persist(data, domain, submitting)
      let status
      try {
        status = await cloudflare.startTransfer(cloudflareConfig, domain.name, args.authCode, transfer.autoRenew)
      } catch (error) {
        const message = safeError(error, args.authCode, cloudflareConfig.apiToken)
        if (error instanceof HttpError && [400, 401, 403, 404, 422].includes(error.status)) {
          await persist(data, domain, { ...submitting, state: 'failed', message })
          throw new Error(
            `${message}. Cloudflare rejected the request, so no new transfer workflow should exist — confirm with domain_manager_transfer_status before retrying.`,
          )
        }
        throw new Error(
          `${message}. Submission outcome may be unknown; run domain_manager_transfer_status and check the Cloudflare dashboard before any retry.`,
        )
      }
      return complete(data, domain, { ...submitting, ...status, updatedAt: new Date().toISOString() })
    },
  })

  register({
    name: 'domain_manager_transfer_status',
    description: 'Refresh a submitted transfer from Cloudflare. Reports the current stage in plain language (awaiting approval, in progress, action required, blocked, failed, succeeded) with the next action to take. Only verified completion changes the portfolio registrar/expiry/pricing. Safe to repeat; never submits or retries a transfer.',
    parameters: {
      name: { type: 'string', required: true, description: 'Domain with a submitted transfer.' },
    },
    output: output(),
    async execute(args) {
      const data = await loadData(dataFile)
      const domain = requireDomain(data, args.name)
      const transfer = domain.transfer
      if (!transfer || ['ready', 'ineligible'].includes(transfer.state)) throw new Error('No submitted transfer to check')
      requireAccount(transfer, cloudflareConfig)
      if (transfer.state === 'succeeded') return result(domain)
      let status
      try {
        status = await cloudflare.getTransferStatus(cloudflareConfig, domain.name)
      } catch (error) {
        if (
          error instanceof HttpError && error.status === 404 && transfer.state === 'submitting' &&
          /\bno (?:transfer )?workflow found\b/i.test(error.body ?? '')
        ) {
          return persist(data, domain, {
            ...transfer, state: 'failed', updatedAt: new Date().toISOString(),
            message: 'Cloudflare reports no transfer workflow. Verify the dashboard before running a new check and explicitly confirming a retry.',
          })
        }
        throw error
      }
      return complete(data, domain, { ...transfer, ...status, updatedAt: new Date().toISOString() })
    },
  })
}
