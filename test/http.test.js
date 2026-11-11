import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { HttpError, parseJson, redact, requestText } from '../lib/http.js'

test('redact covers credential query parameters, JSON, bearer tokens and URL userinfo', () => {
  const url = 'https://username:password@example.com/?apiToken=secret-token&API_KEY=secret-key&clientip=203.0.113.1'
  const sanitized = redact(url)
  for (const secret of ['username', 'password', 'secret-token', 'secret-key', '203.0.113.1']) {
    assert.ok(!sanitized.includes(secret))
  }
  assert.equal(redact('Authorization: bearer short'), 'Authorization: bearer <redacted>')
  const payload = { api_key: 'secret"key', access_token: 'token-value', password: 'pass', message: 'kept' }
  assert.deepEqual(JSON.parse(redact(JSON.stringify(payload))), {
    api_key: '<redacted>', access_token: '<redacted>', password: '<redacted>', message: 'kept',
  })
})

test('request timeout covers body consumption, not just response headers', async () => {
  let signal
  await assert.rejects(
    () => requestText('https://example.com/', {
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        signal = init.signal
        return {
          status: 200,
          text: () => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('body interrupted')), { once: true })
          }),
        }
      },
    }),
    (error) => {
      assert.ok(error instanceof HttpError)
      assert.match(error.message, /timed out after 20ms/)
      assert.equal(signal.aborted, true)
      return true
    },
  )
})

test('body read failures are wrapped and redacted', async () => {
  await assert.rejects(
    () => requestText('https://example.com/?ApiKey=secret-key', {
      fetchImpl: async () => ({
        status: 200,
        text: async () => { throw new Error('body failed with Bearer token-value') },
      }),
    }),
    (error) => {
      assert.ok(error instanceof HttpError)
      assert.match(error.message, /body failed/)
      assert.ok(!JSON.stringify(error).includes('secret-key'))
      assert.ok(!error.message.includes('token-value'))
      return true
    },
  )
})

test('HTTP status and error body stay available without credential-shaped values', async () => {
  await assert.rejects(
    () => requestText('https://example.com/?ApiKey=secret-key', {
      fetchImpl: async () => ({ status: 403, text: async () => '{"api_key":"secret-key","message":"denied"}' }),
    }),
    (error) => {
      assert.equal(error.status, 403)
      assert.match(error.message, /denied/)
      assert.ok(![error.message, error.url, error.body].some((value) => value.includes('secret-key')))
      return true
    },
  )
})

test('invalid JSON errors do not echo the response body', () => {
  assert.throws(() => parseJson('{"token":"secret-token",oops}', { url: 'https://example.com/?token=secret-token' }), (error) => {
    assert.ok(error instanceof HttpError)
    assert.match(error.message, /response is not JSON/)
    assert.ok(!error.message.includes('secret-token'))
    return true
  })

})

test('redact covers transfer authorization codes and explicitly supplied sensitive values', async () => {
  const sanitized = redact('auth_code=encoded-secret&eppCode=raw-secret {"authCode":"json-secret"}')
  for (const secret of ['encoded-secret', 'raw-secret', 'json-secret']) assert.ok(!sanitized.includes(secret))
  await assert.rejects(() => requestText('https://example.com/', {
    sensitiveValues: ['raw-transfer-secret', 'encoded-transfer-secret'],
    fetchImpl: async () => ({ status: 403, text: async () => 'raw-transfer-secret and encoded-transfer-secret' }),
  }), (error) => {
    assert.ok(!error.message.includes('raw-transfer-secret'))
    assert.ok(!error.body.includes('encoded-transfer-secret'))
    return true
  })
})

test('invalid timeouts and missing fetch implementations fail explicitly', async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(() => requestText('https://example.com/', { timeoutMs }), /positive finite/)
  }
  await assert.rejects(() => requestText('https://example.com/', { fetchImpl: null }), /no fetch implementation/)
})

test('request errors redact known credentials even when echoed without a credential label', async () => {
  for (const options of [
    { url: 'https://example.com/?ApiKey=secret-key', headers: {} },
    { url: 'https://example.com/', headers: { authorization: 'Bearer secret-key' } },
  ]) {
    await assert.rejects(() => requestText(options.url, {
      headers: options.headers,
      fetchImpl: async () => ({ status: 403, text: async () => 'rejected secret-key' }),
    }), (error) => {
      assert.match(error.message, /rejected/)
      assert.ok(!error.message.includes('secret-key'))
      assert.ok(!error.body.includes('secret-key'))
      return true
    })
  }
})

test('real fetch aborts a streaming body after headers have arrived', { timeout: 5000 }, async (t) => {
  let headersSent = false
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.flushHeaders()
    response.write('unfinished response')
    headersSent = true
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const started = Date.now()
  await assert.rejects(() => requestText(`http://127.0.0.1:${address.port}/`, { timeoutMs: 250 }), /timed out after 250ms/)
  assert.equal(headersSent, true)
  assert.ok(Date.now() - started < 2000)
})
