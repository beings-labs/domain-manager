/**
 * Minimal, dependency-free XML parser for registrar APIs.
 *
 * It is deliberately small: namespace prefixes are stripped, DTDs are rejected, and
 * there is no mixed-content fidelity beyond
 * concatenated text. That is enough for the flat response documents registrar APIs
 * return, and it keeps the plugin dependency-free.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text) {
  return text.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw new Error('invalid XML character reference')
      }
      return String.fromCodePoint(code)
    }
    return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : match
  })
}

function parseAttributes(source) {
  const attributes = Object.create(null)
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(source)) !== null) {
    attributes[match[1]] = decode(match[3] ?? match[4] ?? '')
  }
  return attributes
}

/**
 * Parse an XML document into a tree of `{ name, attributes, children, text }` nodes.
 * The document root is returned directly (no synthetic wrapper).
 * @param {string} xml
 * @returns {{name: string, attributes: Record<string,string>, children: any[], text: string}}
 */
export function parseXml(xml) {
  if (typeof xml !== 'string') throw new TypeError('parseXml expects a string')
  const root = { name: '#document', attributes: {}, children: [], text: '' }
  const stack = [root]
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![\s\S]*?>|<\/\s*([^\s>]+)\s*>|<\s*([^\s/>]+)((?:[^"'<>]|"[^"]*"|'[^']*')*?)(\/?)>/g
  let lastIndex = 0
  let match

  const pushText = (text, decodeEntities = true) => {
    if (decodeEntities && text.includes('<')) throw new Error('malformed XML markup')
    const value = decodeEntities ? decode(text) : text
    if (value.trim().length === 0) return
    if (stack.length === 1) throw new Error('XML text must be inside the document root')
    const parent = stack[stack.length - 1]
    parent.text += value
  }

  while ((match = tagRe.exec(xml)) !== null) {
    if (match.index > lastIndex) pushText(xml.slice(lastIndex, match.index))
    lastIndex = tagRe.lastIndex

    if (match[0].startsWith('<!--') || match[0].startsWith('<?') || match[0].startsWith('<!')) {
      if (/^<!DOCTYPE/i.test(match[0])) throw new Error('XML DTDs are not supported')
      if (match[1] !== undefined) pushText(match[1], false)
      continue
    }
    if (match[2] !== undefined) {
      // closing tag
      const name = stripNamespace(match[2])
      if (stack.length === 1 || stack[stack.length - 1].name !== name) throw new Error(`mismatched XML closing tag: ${name}`)
      stack.pop()
      continue
    }
    const name = stripNamespace(match[3])
    const node = { name, attributes: parseAttributes(match[4] ?? ''), children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (match[5] !== '/') stack.push(node)
  }
  if (lastIndex < xml.length) pushText(xml.slice(lastIndex))
  if (stack.length !== 1) throw new Error('unclosed XML element')
  if (root.children.length > 1) throw new Error('XML must have a single document root')
  return root.children[0] ?? { name: '#empty', attributes: {}, children: [], text: '' }
}

function stripNamespace(name) {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

/** Depth-first search for descendants with the given local tag name. */
export function findAll(node, tagName) {
  const found = []
  const stack = [...(node?.children ?? [])].reverse()
  while (stack.length > 0) {
    const current = stack.pop()
    if (current.name === tagName) found.push(current)
    for (let index = (current.children?.length ?? 0) - 1; index >= 0; index -= 1) stack.push(current.children[index])
  }
  return found
}

export function findFirst(node, tagName) {
  return findAll(node, tagName)[0] ?? null
}

export function attr(node, name) {
  if (!node || !node.attributes) return null
  if (Object.hasOwn(node.attributes, name)) return node.attributes[name]
  const lower = name.toLowerCase()
  const key = Object.keys(node.attributes).find((candidate) => candidate.toLowerCase() === lower)
  return key === undefined ? null : node.attributes[key]
}

export function textOf(node) {
  return node ? String(node.text ?? '').trim() : ''
}
