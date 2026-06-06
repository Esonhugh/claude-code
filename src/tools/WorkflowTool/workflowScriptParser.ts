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

function throwParse(message: string): never {
  throw new WorkflowScriptParseError(message)
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (quote === '`' && char === '$' && next === '{') {
        throwParse('meta must be a pure literal: template interpolation not allowed in meta')
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  throwParse('meta must be a pure literal: unterminated object literal')
}

function parseObjectLiteral(objectLiteral: string): unknown {
  if (/\.\.\./.test(objectLiteral)) {
    throwParse('meta must be a pure literal: spread not allowed in meta')
  }
  if (/=>|\bfunction\b|\bnew\b/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: functions not allowed in meta')
  }
  if (/\b(get|set)\s+[A-Za-z_$][\w$]*\s*\(/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: accessors not allowed in meta')
  }
  if (/\[[^\]]+\]\s*:/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: computed keys not allowed in meta')
  }
  if (/`[^`]*\$\{/.test(objectLiteral)) {
    throwParse('meta must be a pure literal: template interpolation not allowed in meta')
  }
  try {
    return Function(`"use strict"; return (${objectLiteral})`)() as unknown
  } catch (error) {
    throwParse(`meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertPlainLiteral(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertPlainLiteral(value[index], `${path}[${index}]`)
    }
    return
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throwParse(`meta must be a pure literal: ${path} is not a plain object`)
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(key)) {
        throwParse(`meta must be a pure literal: reserved key ${key} not allowed in meta`)
      }
      assertPlainLiteral(nested, `${path}.${key}`)
    }
    return
  }

  throwParse(`meta must be a pure literal: ${path} has unsupported value`)
}

function normalizeMeta(value: unknown): WorkflowScriptMeta {
  assertPlainLiteral(value, 'meta')
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
  const objectStart = match[0].length
  if (source[objectStart] !== '{') {
    throwParse('meta must be a pure literal object')
  }
  const objectEnd = findObjectEnd(source, objectStart)
  const objectLiteral = source.slice(objectStart, objectEnd)
  const meta = normalizeMeta(parseObjectLiteral(objectLiteral))
  const scriptBody = source.slice(objectEnd).replace(/^[;\s]*/, '')
  return { meta, scriptBody }
}
