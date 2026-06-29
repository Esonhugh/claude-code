export type WorkflowMetaPhase = {
  title: string
  detail?: string
  model?: string
}

export type WorkflowScriptMeta = {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: WorkflowMetaPhase[]
}

export type ParsedWorkflowScript = {
  meta: WorkflowScriptMeta
  scriptBody: string
}

export class WorkflowScriptParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowScriptParseError'
  }
}

const META_PREFIX = /^\s*export\s+const\s+meta\s*=\s*/
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function hasWorkflowScriptMeta(source: string): boolean {
  return META_PREFIX.test(source)
}

export function workflowErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  const message = String(error).trim()
  return message && message !== 'Error' && message !== '[object Object]' ? message : fallback
}

function throwParse(message: string): never {
  throw new WorkflowScriptParseError(message)
}

class LiteralParser {
  index: number

  constructor(
    private readonly source: string,
    start: number,
  ) {
    this.index = start
  }

  parseObject(path: string): Record<string, unknown> {
    this.skipSpaceAndComments()
    this.expect('{', 'meta must be a pure literal object')
    const result: Record<string, unknown> = {}
    this.skipSpaceAndComments()

    while (!this.consume('}')) {
      if (this.startsWith('...')) {
        throwParse('meta must be a pure literal: spread not allowed in meta')
      }
      if (this.consume('[')) {
        throwParse('meta must be a pure literal: computed keys not allowed in meta')
      }

      const key = this.parsePropertyName()
      if (RESERVED_KEYS.has(key)) {
        throwParse(`meta must be a pure literal: reserved key ${key} not allowed in meta`)
      }
      this.skipSpaceAndComments()

      if (this.consume('(')) {
        throwParse('meta must be a pure literal: functions not allowed in meta')
      }
      if (!this.consume(':')) {
        throwParse('meta must be a pure literal: shorthand properties not allowed in meta')
      }

      result[key] = this.parseValue(`${path}.${key}`)
      this.skipSpaceAndComments()
      if (this.consume(',')) {
        this.skipSpaceAndComments()
        continue
      }
      if (!this.peek('}')) {
        throwParse('meta must be a pure literal: expected comma or closing brace')
      }
    }

    return result
  }

  private parseArray(path: string): unknown[] {
    this.expect('[', 'meta must be a pure literal: expected array')
    const result: unknown[] = []
    this.skipSpaceAndComments()

    while (!this.consume(']')) {
      if (this.startsWith('...')) {
        throwParse('meta must be a pure literal: spread not allowed in meta')
      }
      result.push(this.parseValue(`${path}[${result.length}]`))
      this.skipSpaceAndComments()
      if (this.consume(',')) {
        this.skipSpaceAndComments()
        continue
      }
      if (!this.peek(']')) {
        throwParse('meta must be a pure literal: expected comma or closing bracket')
      }
    }

    return result
  }

  private parseValue(path: string): unknown {
    this.skipSpaceAndComments()
    const char = this.source[this.index]

    if (char === '{') return this.parseObject(path)
    if (char === '[') return this.parseArray(path)
    if (char === '"' || char === "'") return this.parseQuotedString(char)
    if (char === '`') return this.parseTemplateString()
    if (char === '-' || char === '+' || this.isDigit(char)) return this.parseNumber(path)
    if (this.consumeWord('true')) return true
    if (this.consumeWord('false')) return false
    if (this.consumeWord('null')) return null
    if (this.startsWith('function') || this.startsWith('new ')) {
      throwParse('meta must be a pure literal: functions not allowed in meta')
    }

    throwParse(`meta must be a pure literal: ${path} has unsupported value`)
  }

  private parsePropertyName(): string {
    this.skipSpaceAndComments()
    const char = this.source[this.index]
    if (char === '"' || char === "'") return this.parseQuotedString(char)
    if (char === '`') return this.parseTemplateString()
    if (this.isDigit(char)) return this.parseNumber('meta key').toString()

    const identifier = this.parseIdentifier()
    if (!identifier) {
      throwParse('meta must be a pure literal: unsupported property in meta')
    }
    if (identifier === 'get' || identifier === 'set') {
      const checkpoint = this.index
      this.skipSpaceAndComments()
      if (this.parseIdentifier()) {
        this.skipSpaceAndComments()
        if (this.peek('(')) {
          throwParse('meta must be a pure literal: accessors not allowed in meta')
        }
      }
      this.index = checkpoint
    }
    return identifier
  }

  private parseIdentifier(): string | undefined {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.index))
    if (!match) return undefined
    this.index += match[0].length
    return match[0]
  }

  private parseQuotedString(quote: '"' | "'"): string {
    this.expect(quote, 'meta must be a pure literal: expected string')
    let result = ''
    while (this.index < this.source.length) {
      const char = this.source[this.index++]!
      if (char === quote) return result
      if (char === '\\') {
        if (this.index >= this.source.length) break
        const escaped = this.source[this.index++]!
        result += this.decodeEscape(escaped)
        continue
      }
      result += char
    }
    throwParse('meta must be a pure literal: unterminated string')
  }

  private parseTemplateString(): string {
    this.expect('`', 'meta must be a pure literal: expected template string')
    let result = ''
    while (this.index < this.source.length) {
      const char = this.source[this.index++]!
      if (char === '`') return result
      if (char === '$' && this.source[this.index] === '{') {
        throwParse('meta must be a pure literal: template interpolation not allowed in meta')
      }
      if (char === '\\') {
        if (this.index >= this.source.length) break
        const escaped = this.source[this.index++]!
        result += this.decodeEscape(escaped)
        continue
      }
      result += char
    }
    throwParse('meta must be a pure literal: unterminated string')
  }

  private parseNumber(path: string): number {
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index))
    if (!match) {
      throwParse(`meta must be a pure literal: ${path} has unsupported value`)
    }
    this.index += match[0].length
    if (this.source[this.index] === 'n') {
      throwParse(`meta must be a pure literal: ${path} has unsupported value`)
    }
    return Number(match[0])
  }

  private decodeEscape(char: string): string {
    if (char === 'n') return '\n'
    if (char === 'r') return '\r'
    if (char === 't') return '\t'
    if (char === 'b') return '\b'
    if (char === 'f') return '\f'
    if (char === 'v') return '\v'
    if (char === '0') return '\0'
    return char
  }

  private skipSpaceAndComments(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      const next = this.source[this.index + 1]
      if (/\s/.test(char ?? '')) {
        this.index += 1
        continue
      }
      if (char === '/' && next === '/') {
        this.index += 2
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1
        continue
      }
      if (char === '/' && next === '*') {
        this.index += 2
        while (this.index < this.source.length && !(this.source[this.index] === '*' && this.source[this.index + 1] === '/')) {
          this.index += 1
        }
        if (this.index >= this.source.length) throwParse('meta must be a pure literal: unterminated comment')
        this.index += 2
        continue
      }
      return
    }
  }

  private consume(value: string): boolean {
    if (!this.startsWith(value)) return false
    this.index += value.length
    return true
  }

  private consumeWord(value: string): boolean {
    if (!this.startsWith(value)) return false
    const next = this.source[this.index + value.length]
    if (next && /[\w$]/.test(next)) return false
    this.index += value.length
    return true
  }

  private expect(value: string, message: string): void {
    if (!this.consume(value)) throwParse(message)
  }

  private startsWith(value: string): boolean {
    return this.source.startsWith(value, this.index)
  }

  private peek(value: string): boolean {
    return this.source.startsWith(value, this.index)
  }

  private isDigit(char: string | undefined): boolean {
    return !!char && /\d/.test(char)
  }
}

function normalizeMeta(value: unknown): WorkflowScriptMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwParse('meta must be a pure literal object')
  }
  const meta = value as Record<string, unknown>
  if (typeof meta.name !== 'string' || meta.name.length === 0) {
    throwParse('meta.name must be a non-empty string')
  }
  if (typeof meta.description !== 'string' || meta.description.length === 0) {
    throwParse('meta.description must be a non-empty string')
  }
  if (meta.title !== undefined && typeof meta.title !== 'string') {
    throwParse('meta.title must be a string when present')
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') {
    throwParse('meta.whenToUse must be a string when present')
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throwParse('meta.phases must be an array when present')
    for (const phase of meta.phases) {
      if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
        throwParse('meta.phases entries must be objects')
      }
      const candidate = phase as Record<string, unknown>
      if (typeof candidate.title !== 'string' || candidate.title.length === 0) {
        throwParse('meta.phases entries require a non-empty title')
      }
      if (candidate.detail !== undefined && typeof candidate.detail !== 'string') {
        throwParse('meta.phases detail must be a string when present')
      }
      if (candidate.model !== undefined && typeof candidate.model !== 'string') {
        throwParse('meta.phases model must be a string when present')
      }
    }
  }

  return {
    name: meta.name,
    description: meta.description,
    ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
    ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
    ...(Array.isArray(meta.phases) ? { phases: meta.phases as WorkflowMetaPhase[] } : {}),
  }
}

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  if (/^\s*export\s+const\s+meta\s*:/.test(source)) {
    throwParse('Workflow scripts must be plain JavaScript; TypeScript syntax fails to parse.')
  }
  if (/^\s*export\s+(?!const\s+meta\s*=)/.test(source)) {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }
  const match = META_PREFIX.exec(source)
  if (!match) {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }

  const parser = new LiteralParser(source, match[0].length)
  const meta = normalizeMeta(parser.parseObject('meta'))
  const scriptBody = source.slice(parser.index).replace(/^[;\s]*/, '')
  return { meta, scriptBody }
}
