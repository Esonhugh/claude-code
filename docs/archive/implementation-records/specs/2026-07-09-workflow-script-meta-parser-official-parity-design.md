# Workflow Script Meta Parser Official Parity Design

## Context

`recover/claude-v2.1.201.js` extracts workflow script metadata through the recovered `Iv()` function at `recover/claude-v2.1.201.js:370130`. The official flow parses the full script as JavaScript module syntax, requires the first AST statement to be `export const meta = { ... }`, converts the object literal without executing it, normalizes only supported metadata fields, and returns the remaining script body after the metadata export.

The current local implementation in `src/tools/WorkflowTool/workflowScriptParser.ts` already uses AST parsing for the metadata object, but it differs from official behavior in important compatibility details:

- It uses regex plus `parseExpressionAt()` instead of parsing the full module and checking `Program.body[0]`.
- It validates `phases` strictly instead of applying the official loose filtering behavior.
- It accepts unary `+number`, which official rejects.
- It slices `scriptBody` from the object expression end rather than the full export declaration end.
- It uses a broader leading-body trim than the official `replace(/^[;\s]*\n/, '').trimStart()` sequence.

## Goal

Align `workflowScriptParser.ts` with the official v2.1.201 workflow metadata parser behavior for provided workflow scripts.

The alignment target is the official recovered flow:

- `Iv()` main parse/extract flow: `recover/claude-v2.1.201.js:370130-370176`
- `qqp()` meta export shape check: `recover/claude-v2.1.201.js:370177-370187`
- `f4a()` literal conversion: `recover/claude-v2.1.201.js:370188-370223`
- `h4a()` object conversion: `recover/claude-v2.1.201.js:370224-370239`
- `jqp()` key validation: `recover/claude-v2.1.201.js:370241-370253`
- `Wqp()` metadata normalization: `recover/claude-v2.1.201.js:370255-370280`
- `Gqp()` phase filtering: `recover/claude-v2.1.201.js:370281-370306`

## Non-goals

- Do not modify workflow runtime execution, VM sandboxing, task state handling, or `WorkflowTool` input schema.
- Do not modify any file under `recover/`.
- Do not add a second parser or compatibility fallback.
- Do not attempt byte-for-byte error message parity; tests should assert behavior and stable key message fragments.

## Design

### Parser entry

Replace the current regex plus `parseExpressionAt()` entry with full-script Acorn parsing:

```ts
parse(source, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
})
```

After parsing, inspect only `program.body[0]`. The first statement must be an `ExportNamedDeclaration` whose declaration is exactly one `const` declarator named `meta` initialized with an `ObjectExpression`.

Accepted form:

```js
export const meta = {
  name: 'example',
  description: 'Example workflow',
}
```

Rejected forms include:

```js
import x from 'x'
export const meta = { name: 'x', description: 'y' }
```

```js
const meta = { name: 'x', description: 'y' }
```

```js
export let meta = { name: 'x', description: 'y' }
```

```js
export const meta = makeMeta()
```

This mirrors official `Iv()` and `qqp()` behavior and removes regex/parser drift.

### Literal extraction

The metadata export is not executed. The parser converts the metadata AST object into a plain literal value.

Supported value nodes:

- `Literal`
- `ArrayExpression`
- `ObjectExpression`
- `TemplateLiteral` with no expressions
- `UnaryExpression` only for negative numeric literals such as `-1`

Rejected value patterns:

- spread elements
- sparse arrays
- computed keys
- methods
- accessors
- template interpolation
- unary plus such as `+1`
- identifiers
- call expressions
- `new` expressions
- function expressions
- arrow functions

Object keys may be identifiers or literal keys. The reserved keys `__proto__`, `constructor`, and `prototype` remain forbidden.

### Metadata normalization

Normalize metadata according to official `Wqp()` and `Gqp()` behavior.

Required fields:

- `name`: non-empty string
- `description`: non-empty string

Optional fields:

- `title`: preserve only when it is a non-empty string; otherwise omit.
- `whenToUse`: preserve when it is a string, including an empty string.
- `phases`: apply official loose filtering.

`phases` behavior:

- If `phases` is not an array, omit it without error.
- Iterate entries.
- Preserve only entries that are objects, contain `title`, and have `title` as a string.
- For preserved entries, include `detail` only if it is a string.
- Include `model` only if it is a string.
- If no valid entries remain, omit `phases`.

This means a partially invalid phases array does not invalidate the whole workflow metadata block.

### Script body extraction

Use the end position of the full metadata export statement, not the object expression end:

```ts
const scriptBody = source.slice(metaExport.end).replace(/^[;\s]*\n/, '').trimStart()
```

This mirrors official behavior at `recover/claude-v2.1.201.js:370171`.

### Public API shape

Keep the public API stable:

- `parseWorkflowScript(source): ParsedWorkflowScript`
- `hasWorkflowScriptMeta(source): boolean`
- `WorkflowScriptParseError`
- `workflowErrorMessage()`
- exported types

`hasWorkflowScriptMeta()` can remain a lightweight precheck as long as `parseWorkflowScript()` is authoritative and official-aligned.

## Testing

Update `src/tools/WorkflowTool/workflowScriptParser.test.ts`.

Required coverage:

1. Full module parse behavior
   - Top-level `await` and `return` in script body are accepted.
   - TypeScript syntax fails with a plain-JavaScript-oriented error.

2. First statement restriction
   - Statement before metadata fails.
   - Import before metadata fails.
   - `export { meta }` fails.
   - `export let meta = ...` fails.
   - `export const meta = makeMeta()` fails.

3. Literal rules
   - `-1` is accepted.
   - `+1` is rejected.
   - Template literal without interpolation is accepted.
   - Template interpolation is rejected.
   - Computed keys, spread, methods, accessors, and sparse arrays are rejected.
   - Reserved keys are rejected.

4. Official loose normalization
   - Empty `title` is omitted.
   - Empty `whenToUse` is preserved.
   - Non-array `phases` is omitted without error.
   - Invalid phase entries are skipped.
   - Valid phase entries are preserved.
   - Non-string `detail` and `model` are omitted.

5. Script body extraction
   - Semicolon plus newline after metadata extracts correctly.
   - No-semicolon newline after metadata extracts correctly.
   - Leading whitespace after metadata follows official trim behavior.

## Implementation boundary

Implementation should touch only:

- `src/tools/WorkflowTool/workflowScriptParser.ts`
- `src/tools/WorkflowTool/workflowScriptParser.test.ts`

If implementation reveals a necessary additional test fixture, keep it local to the parser test unless broader workflow behavior must be verified.

## Verification

Minimum verification commands after implementation:

```bash
bun test src/tools/WorkflowTool/workflowScriptParser.test.ts
```

If parser behavior is used by nearby workflow loading paths during the implementation, also run:

```bash
bun test src/tools/WorkflowTool/workflowDsl.test.ts src/tools/WorkflowTool/workflowScriptRuntime.test.ts src/tools/WorkflowTool/WorkflowTool.test.ts
```

## Risks and mitigations

- Risk: Existing tests or local workflows may rely on stricter phase validation.
  - Mitigation: This is intentional official parity. Add tests documenting the loose official behavior.

- Risk: Error text changes could break brittle assertions.
  - Mitigation: Keep key message fragments stable where practical; tests should match behavior-oriented fragments.

- Risk: Full-script parsing changes acceptance of scripts where regex found `meta` but module parse fails.
  - Mitigation: Official behavior parses the full script first. This is required for parity.

## Approval status

User approved方案 2: official-style parser rewrite.