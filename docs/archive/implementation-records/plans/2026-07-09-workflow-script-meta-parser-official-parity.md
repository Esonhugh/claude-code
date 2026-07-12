# Workflow Script Meta Parser Official Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align workflow script `meta` extraction with official Claude Code v2.1.201 behavior.

**Architecture:** Replace the current regex + `parseExpressionAt()` metadata parser with an official-style full-script Acorn parser that checks the first AST statement, converts the `meta` object literal without executing it, applies official loose normalization, and extracts `scriptBody` from the full export declaration end. Keep the public parser API stable and limit changes to parser implementation and parser tests.

**Tech Stack:** TypeScript, Acorn, Bun test runner, existing `WorkflowScriptParseError` parser API.

---

## File Structure

- Modify: `src/tools/WorkflowTool/workflowScriptParser.ts`
  - Responsibility: parse workflow script metadata and script body using official-style AST rules.
- Modify: `src/tools/WorkflowTool/workflowScriptParser.test.ts`
  - Responsibility: focused parser regression coverage for official v2.1.201 parity.
- No new production files.
- No changes to runtime, VM sandbox, `WorkflowTool` schema, or `recover/` files.

---

### Task 1: Write official-parity parser tests

**Files:**
- Modify: `src/tools/WorkflowTool/workflowScriptParser.test.ts`

- [ ] **Step 1: Replace parser tests with official-parity coverage**

Replace the entire file `src/tools/WorkflowTool/workflowScriptParser.test.ts` with:

```ts
import assert from 'node:assert/strict'

import {
  parseWorkflowScript,
  WorkflowScriptParseError,
} from './workflowScriptParser.js'

function assertParseError(source: string, pattern: RegExp): void {
  assert.throws(
    () => parseWorkflowScript(source),
    (error: unknown) => {
      assert.equal(error instanceof WorkflowScriptParseError, true)
      assert.match(String((error as Error).message), pattern)
      return true
    },
  )
}

const validScript = `export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  title: 'Find flaky tests',
  whenToUse: 'When CI is flaky',
  phases: [
    { title: 'Scan', detail: 'grep logs', model: 'claude-sonnet-4-6' },
    { title: 'Verify' },
  ],
}

phase('Scan')
const flaky = await agent('Find flaky tests')
return flaky
`

const parsed = parseWorkflowScript(validScript)
assert.deepEqual(parsed.meta, {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  title: 'Find flaky tests',
  whenToUse: 'When CI is flaky',
  phases: [
    { title: 'Scan', detail: 'grep logs', model: 'claude-sonnet-4-6' },
    { title: 'Verify' },
  ],
})
assert.equal(parsed.scriptBody.startsWith("phase('Scan')"), true)

const compactScript = 'export const meta = { name: "x", description: "y" };\nreturn 1'
assert.equal(parseWorkflowScript(compactScript).scriptBody, 'return 1')

const noSemicolonScript = 'export const meta = { name: "x", description: "y" }\nphase("Body")'
assert.equal(parseWorkflowScript(noSemicolonScript).scriptBody, 'phase("Body")')

const whitespaceBodyScript = 'export const meta = { name: "x", description: "y" }\n\n  phase("Body")'
assert.equal(parseWorkflowScript(whitespaceBodyScript).scriptBody, 'phase("Body")')

const topLevelSyntaxScript = `export const meta = { name: 'x', description: 'y' }
await agent('ok')
return 1
`
assert.equal(parseWorkflowScript(topLevelSyntaxScript).scriptBody, "await agent('ok')\nreturn 1")

assertParseError('import x from "x"\nexport const meta = { name: "x", description: "y" }', /FIRST statement/)
assertParseError('const x = 1\nexport const meta = { name: "x", description: "y" }', /FIRST statement/)
assertParseError('export { meta }', /FIRST statement/)
assertParseError('export let meta = { name: "x", description: "y" }', /FIRST statement/)
assertParseError('export const meta = makeMeta()', /FIRST statement/)
assertParseError('export const meta: any = { name: "x", description: "y" }', /plain JavaScript/)
assertParseError('export const meta = { name: "", description: "y" }', /meta\.name/)
assertParseError('export const meta = { name: "x", description: "" }', /meta\.description/)
assertParseError('export const meta = { name: "x", description: "y", value: compute() }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", ...extra }', /pure literal/)
assertParseError('export const meta = { name: `x ${value}`, description: "y" }', /pure literal/)
assertParseError('export const meta = { ["name"]: "x", description: "y" }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", value: +1 }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", values: [1,,2] }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", get value() { return 1 } }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", value() { return 1 } }', /pure literal/)
assertParseError('export const meta = { name: "x", description: "y", __proto__: {} }', /reserved key/)
assertParseError('export const meta = { name: "x", description: "y", constructor: {} }', /reserved key/)
assertParseError('export const meta = { name: "x", description: "y", prototype: {} }', /reserved key/)

const literalScript = `export const meta = {
  name: ` + '`literal-name`' + `,
  description: 'literal description',
  value: -1,
}
return 1
`
assert.equal(parseWorkflowScript(literalScript).meta.name, 'literal-name')

const looseMeta = parseWorkflowScript(`export const meta = {
  name: 'loose',
  description: 'Loose official metadata normalization',
  title: '',
  whenToUse: '',
  phases: [
    null,
    { title: 123, detail: 'bad title' },
    { detail: 'missing title' },
    { title: 'Good', detail: 42, model: false },
    { title: 'Also Good', detail: 'details', model: 'claude-sonnet-4-6' },
  ],
}
return 'ok'
`)
assert.deepEqual(looseMeta.meta, {
  name: 'loose',
  description: 'Loose official metadata normalization',
  whenToUse: '',
  phases: [
    { title: 'Good' },
    { title: 'Also Good', detail: 'details', model: 'claude-sonnet-4-6' },
  ],
})

const nonArrayPhases = parseWorkflowScript(`export const meta = {
  name: 'no-phases',
  description: 'Non-array phases are ignored',
  phases: 'not an array',
}
return 'ok'
`)
assert.deepEqual(nonArrayPhases.meta, {
  name: 'no-phases',
  description: 'Non-array phases are ignored',
})

console.log('workflowScriptParser.test.ts passed')
```

- [ ] **Step 2: Run the parser test and verify it fails**

Run:

```bash
bun test src/tools/WorkflowTool/workflowScriptParser.test.ts
```

Expected: FAIL. The current parser still rejects loose `phases`, accepts unary `+number`, or differs in official full-script parsing behavior.

---

### Task 2: Implement official-style parser extraction

**Files:**
- Modify: `src/tools/WorkflowTool/workflowScriptParser.ts`

- [ ] **Step 1: Replace parser implementation**

Replace the entire file `src/tools/WorkflowTool/workflowScriptParser.ts` with:

```ts
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
```

- [ ] **Step 2: Run the parser test and verify it passes**

Run:

```bash
bun test src/tools/WorkflowTool/workflowScriptParser.test.ts
```

Expected: PASS and output includes `workflowScriptParser.test.ts passed`.

---

### Task 3: Run nearby workflow regressions

**Files:**
- No code changes expected.

- [ ] **Step 1: Run workflow parser-adjacent tests**

Run:

```bash
bun test src/tools/WorkflowTool/workflowDsl.test.ts src/tools/WorkflowTool/workflowScriptRuntime.test.ts src/tools/WorkflowTool/WorkflowTool.test.ts
```

Expected: PASS for all listed files.

- [ ] **Step 2: Run full WorkflowTool subtree tests**

Run:

```bash
bun test src/tools/WorkflowTool
```

Expected: all WorkflowTool tests pass with `0 fail`.

---

### Task 4: Review diff and commit

**Files:**
- Review: `src/tools/WorkflowTool/workflowScriptParser.ts`
- Review: `src/tools/WorkflowTool/workflowScriptParser.test.ts`
- Review: `docs/superpowers/plans/2026-07-09-workflow-script-meta-parser-official-parity.md`

- [ ] **Step 1: Inspect status and diff**

Run:

```bash
git status --short && git diff
```

Expected: only parser implementation, parser test, and this plan file are changed.

- [ ] **Step 2: Commit implementation and plan**

Run:

```bash
git add docs/superpowers/plans/2026-07-09-workflow-script-meta-parser-official-parity.md src/tools/WorkflowTool/workflowScriptParser.ts src/tools/WorkflowTool/workflowScriptParser.test.ts
git commit -m "$(cat <<'EOF'
fix: align workflow script meta parser

Parse workflow script metadata using the official v2.1.201 AST-first rules and document the implementation plan.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

- [ ] **Step 3: Verify clean working tree**

Run:

```bash
git status --short
```

Expected: no output.
