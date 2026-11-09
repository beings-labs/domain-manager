// Test-only stub: enough of the Schemastery chain for Config declarations.
function field(kind, extra = {}) {
  const node = { kind, ...extra }
  node.default = (value) => { node.value = value; return node }
  node.description = () => node
  node.required = () => node
  node.min = () => node
  node.max = () => node
  return node
}
const Schema = {
  string: () => field('string'),
  number: () => field('number'),
  boolean: () => field('boolean'),
  array: () => field('array'),
  object: (shape) => field('object', { shape }),
}
export default Schema
