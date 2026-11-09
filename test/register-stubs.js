// Test-only module resolution hook: map the two host-provided packages onto local
// stubs so `node --test` can import index.js outside the Harness runtime.
// Keeping these out of node_modules matters: an installed copy of this package
// must resolve the host's real @deepseek-ai packages, not stubs.
import { register } from 'node:module'

const map = {
  '@deepseek-ai/dsh-tools': new URL('./stubs/dsh-tools.js', import.meta.url).href,
  '@deepseek-ai/schemastery': new URL('./stubs/schemastery.js', import.meta.url).href,
}

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  const mapped = ${JSON.stringify(map)}
  if (mapped[specifier]) return { url: mapped[specifier], shortCircuit: true }
  return next(specifier, context)
}
`),
)
