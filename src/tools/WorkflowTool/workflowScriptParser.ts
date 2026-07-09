import { parse } from 'acorn'

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

const META_ASSIGNMENT = /^\s*export\s+const\s+meta\s*=/
const BODY_PREFIX = /^[;\s]*\n/
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

type AcornNode = {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

type AcornProgram = AcornNode & {
  body: AcornNode[]
}

export function hasWorkflowScriptMeta(source: string): boolean {
  return META_ASSIGNMENT.test(source)
}

export function workflowErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  const message = String(error).trim()
  return message && message !== 'Error' && message !== '[object Object]' ? message : fallback
}

function throwParse(message: string): never {
  throw new WorkflowScriptParseError(message)
}

function parseProgram(source: string): AcornProgram {
  try {
    return parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AcornProgram
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/^\s*export\s*\{/.test(source)) {
      throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
    }
    throwParse(`Script parse error: ${message}. Workflow scripts must be plain JavaScript — TypeScript syntax (type annotations like \`: string[]\`, interfaces, generics) fails to parse.`)
  }
}

function isMetaExport(node: AcornNode | undefined): boolean {
  if (!node || node.type !== 'ExportNamedDeclaration') return false
  const declaration = node.declaration as AcornNode | undefined
  if (!declaration || declaration.type !== 'VariableDeclaration') return false
  if (declaration.kind !== 'const') return false
  const declarations = declaration.declarations as AcornNode[] | undefined
  if (!declarations || declarations.length !== 1) return false
  const declarator = declarations[0]
  const id = declarator?.id as AcornNode | undefined
  const init = declarator?.init as AcornNode | undefined
  return id?.type === 'Identifier' && id.name === 'meta' && init?.type === 'ObjectExpression'
}

function readMetaExport(source: string): { metaExport: AcornNode, metaObject: AcornNode } {
  const program = parseProgram(source)
  const metaExport = program.body[0]
  if (!isMetaExport(metaExport)) {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }
  const declaration = metaExport.declaration as AcornNode
  const declarations = declaration.declarations as AcornNode[]
  const metaObject = declarations[0]!.init as AcornNode
  return { metaExport, metaObject }
}

function getPropertyKey(property: AcornNode): string {
  if (property.computed) {
    throwParse('meta must be a pure literal: computed keys not allowed in meta')
  }
  const key = property.key as AcornNode | undefined
  let value: string
  if (key?.type === 'Identifier') value = String(key.name)
  else if (key?.type === 'Literal') value = String(key.value)
  else throwParse(`meta must be a pure literal: unsupported key type in meta: ${key?.type ?? 'unknown'}`)
  if (RESERVED_KEYS.has(value)) {
    throwParse(`meta must be a pure literal: reserved key ${value} not allowed in meta`)
  }
  return value
}

function parseLiteralNode(node: AcornNode | null): unknown {
  if (!node) throwParse('meta must be a pure literal: sparse arrays not allowed')
  if (node.type === 'SpreadElement') {
    throwParse('meta must be a pure literal: spread not allowed in meta')
  }

  if (node.type === 'Literal') {
    if (node.regex || node.bigint !== undefined) {
      throwParse(`meta must be a pure literal: unsupported literal in meta: ${node.type}`)
    }
    return node.value
  }

  if (node.type === 'ArrayExpression') {
    const elements = node.elements as Array<AcornNode | null>
    return elements.map(element => parseLiteralNode(element))
  }

  if (node.type === 'ObjectExpression') {
    return parseObjectExpression(node)
  }

  if (node.type === 'TemplateLiteral') {
    const expressions = node.expressions as AcornNode[] | undefined
    if (expressions && expressions.length > 0) {
      throwParse('meta must be a pure literal: template interpolation not allowed in meta')
    }
    const quasis = node.quasis as Array<{ value?: { cooked?: string } }> | undefined
    return quasis?.map(quasi => quasi.value?.cooked ?? '').join('') ?? ''
  }

  if (node.type === 'UnaryExpression') {
    const argument = node.argument as AcornNode | undefined
    if (node.operator === '-' && argument?.type === 'Literal' && typeof argument.value === 'number') {
      return -argument.value
    }
    throwParse('meta must be a pure literal: only negative-number unary allowed in meta')
  }

  throwParse(`meta must be a pure literal: non-literal node type in meta: ${node.type}`)
}

function parseObjectExpression(node: AcornNode): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const entry of node.properties as AcornNode[]) {
    if (entry.type !== 'Property') {
      throwParse('meta must be a pure literal: only plain properties allowed in meta')
    }
    if (entry.computed) {
      throwParse('meta must be a pure literal: computed keys not allowed in meta')
    }
    if (entry.method || entry.kind !== 'init') {
      throwParse('meta must be a pure literal: methods/accessors not allowed in meta')
    }
    const key = getPropertyKey(entry)
    result[key] = parseLiteralNode(entry.value as AcornNode | null)
  }
  return result
}

function normalizePhases(value: unknown): WorkflowMetaPhase[] | undefined {
  if (!Array.isArray(value)) return undefined
  const phases: WorkflowMetaPhase[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !(Object.prototype.hasOwnProperty.call(entry, 'title'))) {
      continue
    }
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.title !== 'string') continue
    phases.push({
      title: candidate.title,
      ...(typeof candidate.detail === 'string' ? { detail: candidate.detail } : {}),
      ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    })
  }
  return phases.length > 0 ? phases : undefined
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
  const phases = normalizePhases(meta.phases)
  return {
    name: meta.name,
    description: meta.description,
    ...(typeof meta.title === 'string' && meta.title.length > 0 ? { title: meta.title } : {}),
    ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
    ...(phases ? { phases } : {}),
  }
}

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const { metaExport, metaObject } = readMetaExport(source)
  return {
    meta: normalizeMeta(parseObjectExpression(metaObject)),
    scriptBody: source.slice(metaExport.end).replace(BODY_PREFIX, '').trimStart(),
  }
}
