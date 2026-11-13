export function fakeCloudflareConnector({ routes = {} } = {}) {
  const registry = new Map()
  const calls = []
  const requests = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return this[name] },
    cloudflareConnector: {
      async request(invocation, options = {}) {
        calls.push({ request: invocation, options })
        const { method = 'GET', path, query, body } = invocation
        requests.push({ method, path, query, body })
        const key = `${method.toUpperCase()} ${path.split('?')[0]}`
        const route = routes[key]
        const answer = typeof route === 'function' ? await route(invocation) : route
        const status = answer?.status ?? (answer === undefined ? 404 : 200)
        const payload = answer && Object.hasOwn(answer, 'body') ? answer.body : answer
        if (status >= 300 || payload?.success === false) {
          const error = new Error(`Cloudflare API error: ${method} ${path} returned HTTP ${status}.\n\n${JSON.stringify(payload)}`)
          error.status = status
          error.code = 'api_error'
          throw error
        }
        return payload
      },
    },
    tools: {
      register: (tool) => registry.set(tool.name, tool),
      schemas: () => [...registry.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
      execute: async () => { throw new Error('Cloudflare requests must use the service, not model tool execution') },
    },
  }
  return { ctx, registry, calls, requests }
}
