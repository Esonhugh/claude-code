import type { ModStateReference } from './types.js'

export type ModStateDeclaration = { plugin: string; keys: string[] }
export type ModTypeContract = {
  nouns: string[]
  state: ModStateDeclaration[]
}

type Token = { kind: 'word' | 'string' | 'punct' | 'template'; text: string; line: number }
const transpiler = new Bun.Transpiler({ loader: 'ts' })

function fail(token: Token | undefined, message: string): never {
  throw new Error(`line ${token?.line ?? 1}: ${message}`)
}

// Templates stay opaque to declaration extraction, but their interpolations
// are scanned too: an import type there still reaches outside the contract.
function scanContract(text: string): Token[] {
  let position = 0
  let line = 1
  function advance(end: number) {
    line += text.slice(position, end).match(/\r\n|[\n\r\u2028\u2029]/g)?.length ?? 0
    position = end
  }
  function scan(interpolation = false): Token[] {
    const tokens: Token[] = []
    let braces = 0
    while (position < text.length) {
      const char = text[position]!
      const token: Token = { kind: 'punct', text: char, line }
      if (/\s/.test(char)) { advance(position + 1); continue }
      if (text.startsWith('//', position)) {
        const end = text.slice(position).search(/[\n\r\u2028\u2029]/)
        const comment = text.slice(position, end < 0 ? text.length : position + end)
        if (/^\/\/\/\s*<reference\s+(?:path|types|lib)\s*=/.test(comment)) {
          fail(token, 'the contract must be self-contained and contain no reference directives')
        }
        advance(end < 0 ? text.length : position + end)
        continue
      }
      if (text.startsWith('/*', position)) {
        const end = text.indexOf('*/', position + 2)
        if (end < 0) fail(token, 'unclosed comment')
        advance(end + 2)
        continue
      }
      if (char === '"' || char === "'") {
        let end = position + 1
        while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1
        const raw = text.slice(position + 1, end)
        token.kind = 'string'
        token.text = raw.replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\r\n|[\s\S]))/gi,
          (_, point, unicode, hex, escaped: string) => point || unicode || hex
            ? String.fromCodePoint(parseInt(point ?? unicode ?? hex, 16))
            : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[escaped] ?? (/^[\r\n\u2028\u2029]/.test(escaped) ? '' : escaped)))
        advance(end + 1)
      } else if (char === '`') {
        token.kind = 'template'
        advance(position + 1)
        while (position < text.length && text[position] !== '`') {
          if (text[position] === '\\') advance(position + 2)
          else if (text.startsWith('${', position)) { advance(position + 2); scan(true) }
          else advance(position + 1)
        }
        advance(position + 1)
      } else if (/\d/.test(char) || char === '.' && /\d/.test(text[position + 1] ?? '')) {
        const number = text.slice(position).match(/^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?)/)![0]
        token.kind = 'word'
        token.text = String(Number(number.replaceAll('_', '')))
        advance(position + number.length)
      } else if (/[\p{ID_Continue}$]/u.test(char)) {
        const word = text.slice(position).match(/^[\p{ID_Continue}$]+/u)![0]
        token.kind = 'word'
        token.text = word
        advance(position + word.length)
      } else {
        advance(position + 1)
        if (interpolation && char === '}' && braces === 0) break
        if (char === '{') braces++
        if (char === '}') braces--
      }
      tokens.push(token)
    }
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]?.kind === 'word' && tokens[i]?.text === 'import' &&
          tokens[i + 1]?.text === '(' && tokens[i + 2]?.kind === 'string') {
        fail(tokens[i], 'the contract must be self-contained and contain no imports')
      }
    }
    return tokens
  }
  return scan()
}

// Only balance type delimiters; Bun owns TypeScript syntax validation.
function skipGroup(tokens: Token[], start: number): number {
  const close = { '{': '}', '[': ']', '(': ')', '<': '>' }[tokens[start]!.text]
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind !== 'punct') continue
    if (token.text === close && !(close === '>' && tokens[i - 1]?.text === '=')) return i + 1
    if ('{[(<'.includes(token.text)) i = skipGroup(tokens, i) - 1
  }
  fail(tokens[start], 'unclosed type delimiter')
}

function members(tokens: Token[]): { name: string; type: Token[] }[] {
  const result: { name: string; type: Token[] }[] = []
  function nameIndex(i: number): number {
    return tokens[i]?.text === 'readonly' && tokens[i + 1]?.kind !== 'punct' ? i + 1 : i
  }
  function isMember(i: number): boolean {
    const index = nameIndex(i)
    const token = tokens[index]
    return (token?.kind === 'word' || token?.kind === 'string') &&
      [':', '?', '(', '<'].includes(tokens[index + 1]?.text ?? '')
  }
  for (let start = 0; start < tokens.length;) {
    if (tokens[start]!.kind === 'punct' && [';', ','].includes(tokens[start]!.text)) { start++; continue }
    let end = start
    let conditional = 0
    const index = nameIndex(start)
    const typeStart = index + (tokens[index + 1]?.text === '?' ? 3 : 2)
    while (end < tokens.length) {
      const token = tokens[end]!
      if (token.kind === 'punct' && [';', ','].includes(token.text)) break
      if (end > start && conditional === 0 && token.line > tokens[end - 1]!.line && isMember(end)) break
      if (end >= typeStart && token.kind === 'punct') {
        if (token.text === '?') conditional++
        if (token.text === ':' && conditional > 0) conditional--
      }
      end = token.kind === 'punct' && '{[(<'.includes(token.text) ? skipGroup(tokens, end) : end + 1
    }
    if (isMember(start)) {
      const index = nameIndex(start)
      let colon = index + 1
      if (tokens[colon]?.text === '?') colon++
      result.push({ name: tokens[index]!.text, type: tokens[colon]?.text === ':' ? tokens.slice(colon + 1, end) : [] })
    }
    start = end
  }
  return result
}

export function parseModTypeContract(text: string): ModTypeContract {
  let output: string
  try {
    output = transpiler.transformSync(text)
  } catch (error) {
    throw new Error(`does not parse as TypeScript: ${String(error)}`)
  }
  const tokens = scanContract(text)
  if (output.replace(/^\s*export\s*\{\s*\};?\s*$/gm, '').trim()) {
    throw new Error('the contract must be self-contained and contain types only')
  }
  const nouns = new Set<string>()
  const states = new Map<string, Set<string>>()
  const is = (i: number, value: string) => tokens[i]?.text === value && tokens[i]?.kind !== 'string' && tokens[i]?.kind !== 'template'
  function interfaceEnd(start: number, augmentation: boolean): number {
    let body = start + 2
    if (!is(body, '{') && augmentation) fail(tokens[start], `${tokens[start + 1]?.text} may not use type parameters or extends`)
    while (body < tokens.length && !is(body, '{')) {
      body = is(body, '<') || is(body, '(') || is(body, '[') ? skipGroup(tokens, body) : body + 1
    }
    if (!is(body, '{')) fail(tokens[start], 'expected interface body')
    const end = skipGroup(tokens, body)
    if (augmentation) {
      const declared = members(tokens.slice(body + 1, end - 1))
      if (tokens[start + 1]?.text === 'EngineInterface') {
        for (const member of declared) nouns.add(member.name)
      } else if (tokens[start + 1]?.text === 'PluginState') {
        for (const member of declared) {
          if (!member.name || member.type[0]?.kind !== 'punct' || member.type[0]?.text !== '{' || skipGroup(member.type, 0) !== member.type.length) continue
          const keys = states.get(member.name) ?? new Set<string>()
          for (const key of members(member.type.slice(1, -1))) keys.add(key.name)
          states.set(member.name, keys)
        }
      }
    }
    return end
  }
  for (let i = 0; i < tokens.length;) {
    if (is(i, 'declare') && is(i + 1, 'module') && tokens[i + 2]?.kind === 'string' &&
        tokens[i + 2]?.text === 'claude-code' && is(i + 3, '{')) {
      const end = skipGroup(tokens, i + 3)
      i += 4
      while (i < end - 1) {
        if (is(i, 'export')) i++
        if (!is(i, 'interface')) fail(tokens[i], "the 'claude-code' augmentation may contain interface declarations only")
        i = interfaceEnd(i, true)
      }
      i = end
    } else if (is(i, 'export') && is(i + 1, 'interface')) {
      i = interfaceEnd(i + 1, false)
    } else if (is(i, 'export') && is(i + 1, 'type') && tokens[i + 2]?.kind === 'word') {
      i += 3
      // A type alias ends at a semicolon or the next declaration. Nested
      // object/function/generic types are skipped as balanced groups.
      while (i < tokens.length && !is(i, ';')) {
        if (tokens[i]?.kind === 'word' && (
          ['export', 'declare', 'const', 'let', 'var', 'function', 'class', 'enum', 'import'].includes(tokens[i]!.text) ||
          ['interface', 'namespace', 'module'].includes(tokens[i]!.text) && tokens[i + 1]?.kind === 'word' ||
          is(i, 'type') && tokens[i + 1]?.kind === 'word' && (is(i + 2, '=') || is(i + 2, '<'))
        )) break
        i = tokens[i]?.kind === 'punct' && '{[(<'.includes(tokens[i]!.text) ? skipGroup(tokens, i) : i + 1
      }
      if (is(i, ';')) i++
    } else if (is(i, 'export') && is(i + 1, '{') && is(i + 2, '}')) {
      i += 3
      if (is(i, ';')) i++
    } else {
      fail(tokens[i], "the contract must be self-contained and contain types only; it may only augment module 'claude-code' at its top level")
    }
  }
  return { nouns: [...nouns], state: [...states].map(([plugin, keys]) => ({ plugin, keys: [...keys] })) }
}

export function validateModStateReferences(input: {
  owner: string
  references: { reads: ModStateReference[]; writes: ModStateReference[] }
  declared: ModStateDeclaration[]
  others?: ModStateDeclaration[]
}): { problems: string[]; unchecked: string[] } {
  const known = new Map<string, Set<string>>()
  for (const declaration of [...input.declared, ...(input.others ?? [])]) {
    const keys = known.get(declaration.plugin) ?? new Set<string>()
    declaration.keys.forEach(key => keys.add(key))
    known.set(declaration.plugin, keys)
  }
  const problems: string[] = []
  const unchecked = new Set<string>()
  for (const reference of input.references.writes) {
    if (reference.plugin !== input.owner) {
      problems.push(`$.state.set refers to ${reference.plugin}.${reference.key}, which ${reference.plugin} owns; only a value's owner may write it`)
    }
  }
  for (const reference of [...input.references.reads, ...input.references.writes]) {
    const display = `${reference.plugin}.${reference.key}`
    if (reference.plugin !== input.owner && input.others === undefined) {
      unchecked.add(display)
      continue
    }
    if (!known.get(reference.plugin)?.has(reference.key)) {
      problems.push(reference.plugin === input.owner
        ? `${display} is not declared in the manifest types contract`
        : `${display} is not declared in any available plugin types contract`)
    }
  }
  return { problems: [...new Set(problems)], unchecked: [...unchecked] }
}
