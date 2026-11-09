/**
 * Small HTTP helper shared by registrar clients.
 *
 * - honours an AbortController timeout,
 * - accepts an injected `fetchImpl` so tests never touch the network,
 * - redacts credential-looking query parameters from error messages and logs.
 */

export class HttpError extends Error {
  constructor(message, { status = null, url = null, body = null } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
  }
}

const SECRET_PARAMS = /(apikey|api_key|token|secret|password|clientip|user)/gi

/** Remove anything that looks like a credential from a URL or free-form message. */
export function redact(value, secrets = []) {
  if (typeof value !== 'string') return value
  const keys = '(?:api[_-]?key|api[_-]?user|user[_-]?name|client[_-]?ip|(?:access[_-]?|refresh[_-]?|api[_-]?)?token|secret|password)'
  let out = value.replace(new RegExp(`(\\b${keys}=)[^&\\s"'<>]+`, 'gi'), '$1<redacted>')
  out = out.replace(new RegExp(`(["']${keys}["']\\s*:\\s*)(["'])(?:\\\\.|[^\\\\])*?\\2`, 'gi'), '$1$2<redacted>$2')
  out = out.replace(/(Bearer\s+)[^\s"',;<>]+/gi, '$1<redacted>')
  out = out.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
  for (const secret of [...new Set(secrets)].filter((value) => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = secret.length >= 8 ? escaped : `(?<![\\w-])${escaped}(?![\\w-])`
    out = out.replace(new RegExp(pattern, 'g'), '<redacted>')
  }
  return out
}

/**
 * Issue a request and return the raw response text.
 * Throws HttpError with a redacted message on transport failure or non-2xx status.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(status:number, body:string) => boolean} [options.allowStatus]
 */
export async function requestText(url, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  allowStatus = (status) => status >= 200 && status < 300,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new HttpError('no fetch implementation available')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new HttpError('timeoutMs must be a positive finite number')
  const parsedUrl = new URL(url)
  const secrets = [...parsedUrl.searchParams]
    .filter(([key]) => /^(?:api[_-]?key|(?:access[_-]?|refresh[_-]?|api[_-]?)?token|secret|password)$/i.test(key))
    .map(([, value]) => value)
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(value)) secrets.push(value.replace(/^Bearer\s+/i, ''))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal })
    const text = await response.text()
    if (!allowStatus(response.status, text)) {
      throw new HttpError(`HTTP ${response.status} from ${redact(url)}: ${redact(text, secrets).slice(0, 400)}`, {
        status: response.status,
        url: redact(url),
        body: redact(text, secrets).slice(0, 2000),
      })
    }
    return text
  } catch (error) {
    if (error instanceof HttpError) throw error
    const reason = controller.signal.aborted || error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : redact(String(error?.message ?? error), secrets)
    throw new HttpError(`request failed: ${reason}`, { url: redact(url) })
  } finally {
    clearTimeout(timer)
  }
}

/** Parse JSON with a readable error that never echoes secrets. */
export function parseJson(text, { url = null } = {}) {
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(`response is not JSON (${redact(url ?? 'unknown url')})`, { url: redact(url ?? '') })
  }
}

export { SECRET_PARAMS }
