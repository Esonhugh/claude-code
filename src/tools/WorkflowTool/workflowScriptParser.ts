import { parseExpressionAt } from 'acorn'

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

type AcornNode = {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

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

function parseMetaObject(source: string, start: number): AcornNode {
  try {
    const node = parseExpressionAt(source, start, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as AcornNode
    if (node.type !== 'ObjectExpression') {
      throwParse('meta must be a pure literal object')
    }
    return node
  } catch (error) {
    if (error instanceof WorkflowScriptParseError) throw error
    throwParse(`meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function getPropertyKey(property: AcornNode): string {
  if (property.computed) {
    throwParse('meta must be a pure literal: computed keys not allowed in meta')
  }
  const key = property.key as AcornNode | undefined
  if (key?.type === 'Identifier') return String(key.name)
  if (key?.type === 'Literal') return String(key.value)
  throwParse('meta must be a pure literal: unsupported property in meta')
}

function parseLiteralNode(node: AcornNode | null, path: string): unknown {
  if (!node) throwParse(`meta must be a pure literal: ${path} has unsupported value`)
  if (node.type === 'SpreadElement') {
    throwParse('meta must be a pure literal: spread not allowed in meta')
  }

  if (node.type === 'Literal') {
    if (node.regex || node.bigint !== undefined) {
      throwParse(`meta must be a pure literal: ${path} has unsupported value`)
    }
    return node.value
  }

  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const argument = node.argument as AcornNode | undefined
    if (argument?.type === 'Literal' && typeof argument.value === 'number') {
      return node.operator === '-' ? -argument.value : argument.value
    }
  }

  if (node.type === 'TemplateLiteral') {
    const expressions = node.expressions as AcornNode[] | undefined
    if (expressions && expressions.length > 0) {
      throwParse('meta must be a pure literal: template interpolation not allowed in meta')
    }
    const quasis = node.quasis as Array<{ value?: { cooked?: string } }> | undefined
    return quasis?.[0]?.value?.cooked ?? ''
  }

  if (node.type === 'ArrayExpression') {
    const elements = node.elements as Array<AcornNode | null>
    return elements.map((element, index) => {
      if (!element) throwParse('meta must be a pure literal: array holes not allowed in meta')
      return parseLiteralNode(element, `${path}[${index}]`)
    })
  }

  if (node.type === 'ObjectExpression') {
    return parseObjectExpression(node, path)
  }

  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'NewExpression') {
    throwParse('meta must be a pure literal: functions not allowed in meta')
  }

  throwParse(`meta must be a pure literal: ${path} has unsupported value`)
}

function parseObjectExpression(node: AcornNode, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const entry of node.properties as AcornNode[]) {
    if (entry.type === 'SpreadElement') {
      throwParse('meta must be a pure literal: spread not allowed in meta')
    }
    if (entry.kind === 'get' || entry.kind === 'set') {
      throwParse('meta must be a pure literal: accessors not allowed in meta')
    }
    if (entry.method) {
      throwParse('meta must be a pure literal: functions not allowed in meta')
    }
    if (entry.shorthand) {
      throwParse('meta must be a pure literal: shorthand properties not allowed in meta')
    }
    const key = getPropertyKey(entry)
    if (RESERVED_KEYS.has(key)) {
      throwParse(`meta must be a pure literal: reserved key ${key} not allowed in meta`)
    }
    result[key] = parseLiteralNode(entry.value as AcornNode | undefined ?? null, `${path}.${key}`)
  }
  return result
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

  const metaObject = parseMetaObject(source, match[0].length)
  const meta = normalizeMeta(parseObjectExpression(metaObject, 'meta'))
  const scriptBody = source.slice(metaObject.end).replace(/^[;\s]*/, '')
  return { meta, scriptBody }
}
