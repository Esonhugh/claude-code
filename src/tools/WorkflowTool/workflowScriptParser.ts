import * as ts from 'typescript'

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

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function hasWorkflowScriptMeta(source: string): boolean {
  const statement = getFirstStatement(source)
  if (!statement || !ts.isVariableStatement(statement)) return false
  if (!hasExportModifier(statement) || !isConstDeclarationList(statement.declarationList)) return false
  const declarations = statement.declarationList.declarations
  return declarations.length === 1 && ts.isIdentifier(declarations[0]!.name) && declarations[0]!.name.text === 'meta'
}

export function workflowErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  const message = String(error).trim()
  return message && message !== 'Error' && message !== '[object Object]' ? message : fallback
}

function throwParse(message: string): never {
  throw new WorkflowScriptParseError(message)
}

function getSourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile('workflow.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

function getFirstStatement(source: string): ts.Statement | undefined {
  return getSourceFile(source).statements[0]
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function isConstDeclarationList(node: ts.VariableDeclarationList): boolean {
  return (node.flags & ts.NodeFlags.Const) !== 0
}

function getPropertyNameText(name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) {
    throwParse('meta must be a pure literal: computed keys not allowed in meta')
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isPrivateIdentifier(name)) {
    throwParse('meta must be a pure literal: private keys not allowed in meta')
  }
  return name.getText()
}

function parseLiteralExpression(node: ts.Expression, path: string): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null

  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text)
    if (node.operator === ts.SyntaxKind.MinusToken) return -value
    if (node.operator === ts.SyntaxKind.PlusToken) return value
  }

  if (ts.isTemplateExpression(node)) {
    throwParse('meta must be a pure literal: template interpolation not allowed in meta')
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element, index) => {
      if (ts.isSpreadElement(element)) {
        throwParse('meta must be a pure literal: spread not allowed in meta')
      }
      return parseLiteralExpression(element, `${path}[${index}]`)
    })
  }

  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        throwParse('meta must be a pure literal: spread not allowed in meta')
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        throwParse('meta must be a pure literal: shorthand properties not allowed in meta')
      }
      if (ts.isMethodDeclaration(property)) {
        throwParse('meta must be a pure literal: functions not allowed in meta')
      }
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        throwParse('meta must be a pure literal: accessors not allowed in meta')
      }
      if (!ts.isPropertyAssignment(property)) {
        throwParse('meta must be a pure literal: unsupported property in meta')
      }
      const key = getPropertyNameText(property.name)
      if (RESERVED_KEYS.has(key)) {
        throwParse(`meta must be a pure literal: reserved key ${key} not allowed in meta`)
      }
      result[key] = parseLiteralExpression(property.initializer, `${path}.${key}`)
    }
    return result
  }

  throwParse(`meta must be a pure literal: ${path} has unsupported value`)
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

function getMetaDeclaration(statement: ts.Statement): ts.VariableDeclaration {
  if (!ts.isVariableStatement(statement) || !hasExportModifier(statement) || !isConstDeclarationList(statement.declarationList)) {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }

  const declarations = statement.declarationList.declarations
  if (declarations.length !== 1) {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }

  const declaration = declarations[0]!
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'meta') {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }
  if (declaration.type) {
    throwParse('Workflow scripts must be plain JavaScript; TypeScript syntax fails to parse.')
  }
  if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
    throwParse('meta must be a pure literal object')
  }

  return declaration
}

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const sourceFile = getSourceFile(source)
  const firstStatement = sourceFile.statements[0]
  if (!firstStatement) {
    throwParse('`export const meta = { name, description, phases }` must be the FIRST statement in the script')
  }
  const declaration = getMetaDeclaration(firstStatement)
  const meta = normalizeMeta(parseLiteralExpression(declaration.initializer!, 'meta'))
  const scriptBody = source.slice(firstStatement.end).replace(/^[;\s]*/, '')
  return { meta, scriptBody }
}
