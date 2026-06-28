# InteractiveTerminal Output Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not create commits unless the user explicitly approves.

**Goal:** Add token-efficient `InteractiveTerminal.read` output modes while preserving readable terminal output and an explicit path to exact visible-screen output.

**Architecture:** Keep `PtySessionManager.read()` unchanged as the source of the full visible-screen snapshot. Add a focused compression helper under `src/tools/InteractiveTerminalTool/`, branch in `handleRead()` for `compact`, `full`, and `save_file`, and update result formatting to keep multi-line output readable. File saving uses a narrow InteractiveTerminal-only writer in the existing tool-results directory pattern.

**Tech Stack:** TypeScript, Zod schemas, Bun tests, Node `Buffer`/`fs`, existing `InteractiveTerminalTool` handlers and UI tests.

---

## File Structure

- Modify `src/tools/InteractiveTerminalTool/actionSchemas.ts`
  - Extend `readActionSchema` with `mode`, `maxLines`, `maxLineChars`, and `previewBytes` defaults.
  - Preserve `cursor` compatibility and `maxBytes` default.

- Create `src/tools/InteractiveTerminalTool/compressReadOutput.ts`
  - Deterministic pure helper for compacting visible-screen plain text.
  - Owns repeated-line collapse, blank-line collapse, middle line elision, max-line elision, and UTF-8-safe byte truncation.
  - Exports types and functions used by `handleRead()` tests.

- Modify `src/tools/InteractiveTerminalTool/handlers/read.ts`
  - Use helper for `compact` default and `full` compatibility mode.
  - Add `save_file` mode that writes the full visible-screen snapshot and returns compact preview metadata.
  - Keep `manager.read()` and cursor behavior unchanged.

- Modify or create tests in `src/tools/InteractiveTerminalTool/handlers/read.test.ts`
  - Cover default compact metadata/compression, full compatibility, save_file, UTF-8 truncation, repeated/blank line collapse, long-line middle elision, max-line elision, and cursor compatibility.

- Modify `src/tools/InteractiveTerminalTool/formatToolResultMessage.ts`
  - Render compact/full read output with readable multi-line text.
  - Render save_file with concise path and preview without flooding UI.

- Modify tests in `src/tools/InteractiveTerminalTool/UI.test.ts` and/or `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
  - Cover result message formatting and schema/tool behavior for the new read modes.

---

## Task 1: Extend `read` schema

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/actionSchemas.ts`
- Test: existing schema/tool tests in `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add a test near existing InteractiveTerminal tool schema tests that validates default read arguments. If the file currently tests via the tool input parser, use the existing helper style; otherwise add the smallest direct schema test export already available in the file.

```ts
test('read action schema defaults to compact compression options', () => {
  const input = readActionSchema.parse({
    action: 'read',
    sessionId: 'sess-1',
  })

  assert.equal(input.mode, 'compact')
  assert.equal(input.maxBytes, 8192)
  assert.equal(input.maxLines, 80)
  assert.equal(input.maxLineChars, 240)
  assert.equal(input.previewBytes, 2000)
  assert.equal(input.cursor, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
```

Expected: FAIL because `mode`, `maxLines`, `maxLineChars`, and `previewBytes` are not present on parsed read input.

- [ ] **Step 3: Extend the schema**

Update `readActionSchema` in `src/tools/InteractiveTerminalTool/actionSchemas.ts` to include the new defaults.

```ts
export const readActionSchema = z.object({
  action: z.literal('read'),
  sessionId: z.string().min(1),
  cursor: z.number().int().min(0).default(0),
  maxBytes: z.number().int().positive().default(8192),
  mode: z.enum(['compact', 'full', 'save_file']).default('compact'),
  maxLines: z.number().int().positive().default(80),
  maxLineChars: z.number().int().positive().default(240),
  previewBytes: z.number().int().positive().default(2000),
})
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
```

Expected: PASS for the new schema test and existing tests.

---

## Task 2: Add deterministic compact compression helper

**Files:**
- Create: `src/tools/InteractiveTerminalTool/compressReadOutput.ts`
- Test: `src/tools/InteractiveTerminalTool/handlers/read.test.ts`

- [ ] **Step 1: Write failing helper tests**

Add tests to `src/tools/InteractiveTerminalTool/handlers/read.test.ts` importing the helper directly.

```ts
import {
  compactReadOutput,
  truncateUtf8Bytes,
} from '../compressReadOutput'
```

Add these tests:

```ts
test('compactReadOutput collapses repeated lines and blank runs', () => {
  const input = [
    'ready',
    'same',
    'same',
    'same',
    '',
    '',
    '',
    '',
    'done',
  ].join('\n')

  const result = compactReadOutput(input, {
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 80,
  })

  assert.equal(
    result.text,
    [
      'ready',
      'same',
      '[... repeated 2 more times ...]',
      '[... 4 blank lines omitted ...]',
      'done',
    ].join('\n'),
  )
  assert.equal(result.compressed, true)
  assert.equal(result.omittedLines, 6)
})

test('compactReadOutput elides long lines in the middle', () => {
  const result = compactReadOutput('prefix-abcdefghijklmnopqrstuvwxyz-suffix', {
    maxBytes: 8192,
    maxLineChars: 24,
    maxLines: 80,
  })

  assert.match(result.text, /^prefix-/)
  assert.match(result.text, /suffix$/)
  assert.match(result.text, /\[\.\.\. \d+ chars omitted \.\.\.\]/)
  assert.equal(result.compressed, true)
  assert.ok(result.omittedChars > 0)
})

test('compactReadOutput keeps top and bottom context when line budget is exceeded', () => {
  const input = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n')
  const result = compactReadOutput(input, {
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 12,
  })

  assert.ok(result.text.startsWith('line-1\nline-2'))
  assert.match(result.text, /\[\.\.\. 8 lines omitted \.\.\.\]/)
  assert.ok(result.text.endsWith('line-20'))
  assert.equal(result.omittedLines, 8)
})

test('truncateUtf8Bytes does not split CJK or emoji characters', () => {
  assert.equal(truncateUtf8Bytes('你好🙂abc', 10), '你好🙂')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: FAIL because `compressReadOutput.ts` does not exist or exports are missing.

- [ ] **Step 3: Create compression helper**

Create `src/tools/InteractiveTerminalTool/compressReadOutput.ts` with focused pure functions.

```ts
export type CompactReadOutputOptions = {
  maxBytes: number
  maxLines: number
  maxLineChars: number
}

export type CompactReadOutputResult = {
  text: string
  compressed: boolean
  originalBytes: number
  returnedBytes: number
  omittedLines: number
  omittedChars: number
}

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }

  let end = maxBytes
  while (end > 0) {
    const decoded = buffer.subarray(0, end).toString('utf8')
    if (!decoded.includes('�')) {
      return decoded
    }
    end -= 1
  }
  return ''
}

function elideLine(
  line: string,
  maxLineChars: number,
): { line: string; omittedChars: number } {
  if (line.length <= maxLineChars) {
    return { line, omittedChars: 0 }
  }

  const markerFor = (count: number) => `[... ${count} chars omitted ...]`
  let marker = markerFor(0)
  const available = Math.max(0, maxLineChars - marker.length)
  const prefixLength = Math.ceil(available * 0.6)
  const suffixLength = Math.max(0, available - prefixLength)
  const omittedChars = line.length - prefixLength - suffixLength
  marker = markerFor(omittedChars)

  return {
    line: `${line.slice(0, prefixLength)}${marker}${
      suffixLength > 0 ? line.slice(line.length - suffixLength) : ''
    }`,
    omittedChars,
  }
}

function collapseRuns(lines: string[]): {
  lines: string[]
  omittedLines: number
} {
  const output: string[] = []
  let omittedLines = 0
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line === '') {
      let end = index + 1
      while (end < lines.length && lines[end] === '') end += 1
      const count = end - index
      if (count >= 3) {
        output.push(`[... ${count} blank lines omitted ...]`)
        omittedLines += count
      } else {
        output.push(...lines.slice(index, end))
      }
      index = end
      continue
    }

    let end = index + 1
    while (end < lines.length && lines[end] === line) end += 1
    const count = end - index
    output.push(line)
    if (count >= 3) {
      output.push(`[... repeated ${count - 1} more times ...]`)
      omittedLines += count - 1
    } else if (count === 2) {
      output.push(line)
    }
    index = end
  }

  return { lines: output, omittedLines }
}

function limitLines(lines: string[], maxLines: number): {
  lines: string[]
  omittedLines: number
} {
  if (lines.length <= maxLines) {
    return { lines, omittedLines: 0 }
  }

  const topCount = Math.min(10, Math.max(1, maxLines - 2))
  const bottomCount = Math.max(1, maxLines - topCount - 1)
  const omittedLines = lines.length - topCount - bottomCount

  return {
    lines: [
      ...lines.slice(0, topCount),
      `[... ${omittedLines} lines omitted ...]`,
      ...lines.slice(lines.length - bottomCount),
    ],
    omittedLines,
  }
}

export function compactReadOutput(
  text: string,
  options: CompactReadOutputOptions,
): CompactReadOutputResult {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const collapsed = collapseRuns(text.split('\n'))

  let omittedChars = 0
  const lineElided = collapsed.lines.map(line => {
    const result = elideLine(line, options.maxLineChars)
    omittedChars += result.omittedChars
    return result.line
  })

  const lineLimited = limitLines(lineElided, options.maxLines)
  const truncated = truncateUtf8Bytes(lineLimited.lines.join('\n'), options.maxBytes)
  const returnedBytes = Buffer.byteLength(truncated, 'utf8')

  return {
    text: truncated,
    compressed:
      collapsed.omittedLines > 0 ||
      omittedChars > 0 ||
      lineLimited.omittedLines > 0 ||
      returnedBytes < Buffer.byteLength(lineLimited.lines.join('\n'), 'utf8'),
    originalBytes,
    returnedBytes,
    omittedLines: collapsed.omittedLines + lineLimited.omittedLines,
    omittedChars,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: PASS for helper tests and existing read tests.

---

## Task 3: Implement `compact` and `full` read modes in handler

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/handlers/read.ts`
- Test: `src/tools/InteractiveTerminalTool/handlers/read.test.ts`

- [ ] **Step 1: Write failing handler tests**

Add tests to `src/tools/InteractiveTerminalTool/handlers/read.test.ts`.

```ts
test('handleRead default mode returns compact metadata and compressed text', () => {
  const manager = new PtySessionManager()
  const session = manager.open({ cols: 80, rows: 24 })
  manager.write(session.sessionId, `${Array.from({ length: 6 }, () => 'repeat').join('\n')}\n`)

  const result = handleRead(manager, {
    action: 'read',
    cursor: 0,
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 80,
    mode: 'compact',
    previewBytes: 2000,
    sessionId: session.sessionId,
  })

  assert.equal(result.mode, 'compact')
  assert.equal(result.compressed, true)
  assert.match(result.text, /\[\.\.\. repeated \d+ more times \.\.\.\]/)
  assert.ok(result.originalBytes >= result.returnedBytes)
  assert.ok(result.omittedLines > 0)
})

test('handleRead full mode preserves current visible snapshot behavior', () => {
  const manager = new PtySessionManager()
  const session = manager.open({ cols: 80, rows: 24 })
  manager.write(session.sessionId, 'alpha\nbeta\n')

  const result = handleRead(manager, {
    action: 'read',
    cursor: 999,
    maxBytes: 4096,
    maxLineChars: 240,
    maxLines: 80,
    mode: 'full',
    previewBytes: 2000,
    sessionId: session.sessionId,
  })

  assert.equal(result.mode, 'full')
  assert.equal(result.compressed, false)
  assert.equal(result.text, 'alpha\nbeta')
  assert.equal(result.fromCursor, 0)
  assert.equal(result.toCursor, Buffer.byteLength('alpha\nbeta', 'utf8'))
  assert.equal(result.originalBytes, Buffer.byteLength('alpha\nbeta', 'utf8'))
  assert.equal(result.returnedBytes, Buffer.byteLength('alpha\nbeta', 'utf8'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: FAIL because `handleRead()` does not return `mode`, `compressed`, `originalBytes`, `returnedBytes`, `omittedLines`, or `omittedChars`.

- [ ] **Step 3: Update `handleRead()` for compact/full**

Replace the local truncation function in `src/tools/InteractiveTerminalTool/handlers/read.ts` with imports from the helper and branch on `input.mode`.

```ts
import {
  compactReadOutput,
  truncateUtf8Bytes,
} from '../compressReadOutput'
```

Use this handler shape:

```ts
export function handleRead(manager: PtySessionManager, input: ReadActionInput) {
  const result = manager.read(input.sessionId, input.cursor)
  const fullText = result.chunks.map(chunk => chunk.text).join('')
  const status = manager.status(input.sessionId)
  const originalBytes = Buffer.byteLength(fullText, 'utf8')
  const toCursor = originalBytes
  const base = {
    sessionId: input.sessionId,
    fromCursor: 0,
    toCursor,
    rows: status.rows,
    cols: status.cols,
    isRunning: status.state === 'running',
    exitCode: status.exitCode ?? null,
    truncatedBeforeCursor: result.truncatedBeforeCursor,
  }

  if (input.mode === 'full') {
    const text = truncateUtf8Bytes(fullText, input.maxBytes)
    return {
      ...base,
      text,
      mode: 'full' as const,
      compressed: false,
      originalBytes,
      returnedBytes: Buffer.byteLength(text, 'utf8'),
    }
  }

  const compact = compactReadOutput(fullText, {
    maxBytes: input.maxBytes,
    maxLineChars: input.maxLineChars,
    maxLines: input.maxLines,
  })

  return {
    ...base,
    text: compact.text,
    mode: 'compact' as const,
    compressed: compact.compressed,
    originalBytes: compact.originalBytes,
    returnedBytes: compact.returnedBytes,
    omittedLines: compact.omittedLines,
    omittedChars: compact.omittedChars,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: PASS for default compact, full compatibility, and existing cursor compatibility tests.

---

## Task 4: Implement `save_file` read mode

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/handlers/read.ts`
- Test: `src/tools/InteractiveTerminalTool/handlers/read.test.ts`
- Inspect if needed before implementation: `src/utils/toolResultStorage.ts`

- [ ] **Step 1: Read storage helper before editing**

Read `src/utils/toolResultStorage.ts` and confirm whether `ensureToolResultsDir()` / `getToolResultsDir()` can be imported without creating SDK-mapped result blocks. If they are safe, use them. If not, mirror only the local directory pattern in `read.ts` with a focused private function.

- [ ] **Step 2: Write failing save_file test**

Add this test to `src/tools/InteractiveTerminalTool/handlers/read.test.ts`.

```ts
import { existsSync, readFileSync } from 'node:fs'
```

```ts
test('handleRead save_file writes full visible snapshot and returns compact preview', () => {
  const manager = new PtySessionManager()
  const session = manager.open({ cols: 120, rows: 24 })
  const fullText = [
    'start',
    ...Array.from({ length: 6 }, () => 'repeat'),
    'end',
  ].join('\n')
  manager.write(session.sessionId, `${fullText}\n`)

  const result = handleRead(manager, {
    action: 'read',
    cursor: 0,
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 80,
    mode: 'save_file',
    previewBytes: 2000,
    sessionId: session.sessionId,
  })

  assert.equal(result.mode, 'save_file')
  assert.equal(typeof result.filePath, 'string')
  assert.ok(existsSync(result.filePath))
  assert.equal(readFileSync(result.filePath, 'utf8'), fullText)
  assert.match(result.preview, /\[\.\.\. repeated \d+ more times \.\.\.\]/)
  assert.equal(result.originalBytes, Buffer.byteLength(fullText, 'utf8'))
  assert.equal(result.previewBytes, Buffer.byteLength(result.preview, 'utf8'))
})
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: FAIL because `save_file` mode currently falls through to compact mode or lacks `filePath`/`preview`.

- [ ] **Step 4: Add narrow file writer**

In `src/tools/InteractiveTerminalTool/handlers/read.ts`, import Node fs/path helpers and storage helpers if safe.

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getToolResultsDir, ensureToolResultsDir } from '../../../utils/toolResultStorage'
```

Add a private writer near the handler.

```ts
function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

function writeReadSnapshot(sessionId: string, text: string): string {
  ensureToolResultsDir()
  const dir = getToolResultsDir()
  mkdirSync(dir, { recursive: true })
  const filePath = join(
    dir,
    `interactive-terminal-read-${safeFilePart(sessionId)}-${Date.now()}.txt`,
  )
  writeFileSync(filePath, text, 'utf8')
  return filePath
}
```

Add the `save_file` branch before `full`/`compact` return.

```ts
if (input.mode === 'save_file') {
  const compact = compactReadOutput(fullText, {
    maxBytes: input.previewBytes,
    maxLineChars: input.maxLineChars,
    maxLines: input.maxLines,
  })
  const preview = truncateUtf8Bytes(compact.text, input.previewBytes)

  return {
    ...base,
    mode: 'save_file' as const,
    filePath: writeReadSnapshot(input.sessionId, fullText),
    preview,
    previewBytes: Buffer.byteLength(preview, 'utf8'),
    originalBytes,
  }
}
```

If `toolResultStorage` helpers are not safe in this context, implement only the directory equivalent observed in that file and keep it private to `read.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: PASS for save_file and all read handler tests.

---

## Task 5: Update result formatting for readable display

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/formatToolResultMessage.ts`
- Test: `src/tools/InteractiveTerminalTool/UI.test.ts` or existing format-result tests

- [ ] **Step 1: Write failing formatting tests**

Add tests in the existing UI/format test location for compact and save_file outputs.

```ts
test('formatToolResultMessage renders compact read output as readable multiline text', () => {
  const message = formatToolResultMessage({
    sessionId: 'sess-1',
    mode: 'compact',
    text: 'alpha\nbeta',
    compressed: false,
    originalBytes: 10,
    returnedBytes: 10,
  })

  assert.equal(message, 'read sess-1 (compact)\nalpha\nbeta')
})

test('formatToolResultMessage renders save_file with path and preview', () => {
  const message = formatToolResultMessage({
    sessionId: 'sess-1',
    mode: 'save_file',
    filePath: '/tmp/tool-results/read.txt',
    preview: 'alpha\nbeta',
    originalBytes: 10,
    previewBytes: 10,
  })

  assert.equal(
    message,
    'read sess-1 saved to /tmp/tool-results/read.txt\npreview:\nalpha\nbeta',
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/UI.test.ts
```

Expected: FAIL because current formatting returns `read <sessionId> → <text>` and does not recognize `save_file`.

- [ ] **Step 3: Update formatter**

Update `src/tools/InteractiveTerminalTool/formatToolResultMessage.ts`.

```ts
export function formatToolResultMessage(
  output: Record<string, unknown>,
): string | null {
  if ('error' in output) {
    const error = output.error as { code?: string; message?: string }
    return `${error.code ?? 'ERROR'}: ${error.message ?? 'unknown error'}`
  }

  if ('sessionId' in output && output.mode === 'save_file') {
    const preview = typeof output.preview === 'string' ? output.preview : ''
    return `read ${String(output.sessionId)} saved to ${String(
      output.filePath,
    )}\npreview:\n${preview}`
  }

  if ('sessionId' in output && 'text' in output) {
    const mode = typeof output.mode === 'string' ? output.mode : 'full'
    return `read ${String(output.sessionId)} (${mode})\n${String(output.text)}`
  }

  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/UI.test.ts
```

Expected: PASS for formatting tests and existing UI tests.

---

## Task 6: Verify tool integration and type consistency

**Files:**
- Modify only if test failures reveal type/schema mismatches:
  - `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
  - `src/tools/InteractiveTerminalTool/handlers/index.ts`
  - `src/tools/InteractiveTerminalTool/types.ts` if present
- Test: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`

- [ ] **Step 1: Run tool integration test**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
```

Expected: PASS. If TypeScript or runtime schema mismatch fails, read the failing file and adjust only the mismatched type/export path.

- [ ] **Step 2: If needed, update output type union**

If the tool declares a narrow output type that rejects new result fields, extend it to this shape without changing other action outputs.

```ts
type ReadCompactOutput = {
  sessionId: string
  fromCursor: 0
  toCursor: number
  text: string
  mode: 'compact'
  compressed: boolean
  originalBytes: number
  returnedBytes: number
  omittedLines: number
  omittedChars: number
  rows: number
  cols: number
  isRunning: boolean
  exitCode: number | null
  truncatedBeforeCursor: boolean
}

type ReadFullOutput = Omit<
  ReadCompactOutput,
  'mode' | 'omittedLines' | 'omittedChars'
> & {
  mode: 'full'
  compressed: false
}

type ReadSaveFileOutput = {
  sessionId: string
  mode: 'save_file'
  filePath: string
  preview: string
  previewBytes: number
  originalBytes: number
  rows: number
  cols: number
  isRunning: boolean
  exitCode: number | null
  truncatedBeforeCursor: boolean
}
```

Use the repository's existing type location and naming rather than creating a new shared abstraction.

- [ ] **Step 3: Re-run integration test**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
```

Expected: PASS.

---

## Task 7: Run focused verification and build

**Files:**
- No planned source edits unless verification reveals failures.

- [ ] **Step 1: Run focused read handler tests**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run UI formatting tests**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/UI.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run tool integration tests**

Run:

```sh
bun test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```sh
make build
```

Expected: exit code 0 and `./built-claude` rebuilt successfully.

- [ ] **Step 5: Inspect diff before handoff**

Run:

```sh
git status --short
git diff -- src/tools/InteractiveTerminalTool docs/superpowers/plans/2026-06-28-interactive-terminal-output-compression.md
```

Expected: only planned source/test changes and this plan file are present. Remove accidental debug artifacts or generated snapshots if any test wrote them into the repository.

---

## Self-Review

- Spec coverage:
  - `compact` default mode: Tasks 1-3.
  - `full` compatibility mode: Task 3.
  - `save_file` full snapshot + compact preview: Task 4.
  - UTF-8 safe truncation: Task 2.
  - Repeated/blank/long/max-line compression: Task 2.
  - Cursor compatibility: Task 3 keeps existing semantics and test coverage.
  - Display correctness: Task 5.
  - Task preview unchanged: no task edits `PtySessionManager.getRenderedPreview()` or preview call sites.
  - Build/focused verification: Task 7.

- Placeholder scan:
  - No `TBD`, `TODO`, or unspecified implementation sections.
  - The only conditional branch is explicit: inspect `toolResultStorage.ts` and either use safe exports or mirror its directory pattern locally.

- Type consistency:
  - Input mode values are consistently `compact`, `full`, and `save_file`.
  - Defaults match the design: `maxBytes=8192`, `maxLines=80`, `maxLineChars=240`, `previewBytes=2000`.
  - `save_file` returns `previewBytes` as the actual returned preview byte count, with the input field serving as the cap.

## Handoff

Implement this plan without committing unless the user explicitly approves. Use TDD for each task: write the failing test, verify the failure, implement the minimal code, verify the pass, then continue.
