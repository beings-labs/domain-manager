// Dev-only probe: exercises the real tool registry.
// 1. registers fake registrar MCP tools (mcp__namecheap__*) to test the MCP provider path,
// 2. dispatches domain_manager_report, domain_manager_sync and domain_manager_check_availability.
//
// The fake MCP tools declare a string output, mirroring how MCP tools surface
// their text content, so the adapter's parsing path is exercised too.
export const name = 'domains-probe'
export const inject = ['tools']

function fakeTool(name, description, parameters, payload) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return JSON.stringify(payload(args ?? {}))
    },
  }
}

const FAKE_LIST = fakeTool(
  'mcp__namecheap__domains_list',
  'Fake Namecheap MCP domain_manager_list (probe only).',
  { type: 'object', properties: {} },
  () => ({
    domains: [
      { name: 'example.com', expires: '2027-03-15', autoRenew: true, renewalPrice: 9.15, currency: 'USD' },
      { name: 'example.dev', expires: '03/12/2027', autoRenew: false },
    ],
  }),
)

const FAKE_CHECK = fakeTool(
  'mcp__namecheap__domains_check_availability',
  'Fake Namecheap MCP availability check (probe only).',
  { type: 'object', properties: { domains: { type: 'array' } } },
  (args) => ({ domains: (args.domains ?? []).map((name) => ({ name, available: true, registrationPrice: '8.57' })) }),
)

export async function apply(ctx) {
  const log = (...args) => console.log('[PROBE]', ...args)
  await new Promise((resolve) => setTimeout(resolve, 4000))

  for (const tool of [FAKE_LIST, FAKE_CHECK]) {
    try {
      ctx.tools.register(tool)
      log('registered', tool.name)
    } catch (error) {
      log('could not register', tool.name, '-', error.message)
    }
  }

  const run = async (id, name, args) => {
    const controller = new AbortController()
    try {
      const batch = await ctx.tools.execute({ calls: [{ id, name, arguments: args }], signal: controller.signal })
      return JSON.stringify(batch.results?.[0]?.result ?? null)
    } catch (error) {
      return `ERROR ${error.message}`
    }
  }

  log('domain_manager_report ->', (await run('p1', 'domain_manager_report', {})).slice(0, 300))
  log('domain_manager_sync(namecheap) ->', (await run('p2', 'domain_manager_sync', { registrar: 'namecheap' })).slice(0, 700))
  log('domain_manager_check_availability ->', (await run('p3', 'domain_manager_check_availability', { domains: 'example.dev' })).slice(0, 500))
}
