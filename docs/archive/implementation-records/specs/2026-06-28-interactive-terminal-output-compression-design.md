# InteractiveTerminal Read Output Compression Design

Date: 2026-06-28

## Goal

Reduce tokens from `InteractiveTerminal.read` tool results while preserving readable terminal output and an explicit escape hatch for exact visible-screen output.

The change should only affect the `read` action response shape. It must not mutate PTY session state, scrollback state, rendered screen state, or task preview behavior.

## Current behavior

Source-confirmed current behavior:

- `src/tools/InteractiveTerminalTool/actionSchemas.ts` defines `read` with `sessionId`, compatibility `cursor`, and `maxBytes`.
- `src/tools/InteractiveTerminalTool/handlers/read.ts` calls `manager.read()`, joins returned chunks, then applies UTF-8-safe byte truncation.
- `src/utils/pty/PtySessionManager.ts` returns the current visible terminal screen snapshot via `renderedPreview(session.renderer)`, not raw scrollback.
- `src/utils/pty/terminalScreenRenderer.ts` uses `@xterm/headless` and returns visible lines as plain text; ANSI/control sequence handling is already normalized before `read` sees text.
- `src/tools/InteractiveTerminalTool/formatToolResultMessage.ts` currently renders read results as `read <sessionId> → <text>`.

## API design

Extend `read` input with:

```ts
mode?: 'compact' | 'full' | 'save_file'
maxLines?: number
maxLineChars?: number
previewBytes?: number
```

Defaults:

```text
mode = compact
maxBytes = 8192
maxLines = 80
maxLineChars = 240
previewBytes = 2000
```

`cursor` remains accepted for compatibility, but read still returns the current visible screen snapshot rather than incremental scrollback. Do not broaden scope to cursor-based incremental history in this change.

## Modes

### `compact`

Default mode. Return a deterministic compressed visible-screen snapshot in `text`.

Response fields:

```ts
{
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
```

Compression rules:

1. Start from the plain text returned by `renderedPreview()`.
2. Preserve display correctness:
   - Do not emit raw ANSI escape sequences.
   - Do not break UTF-8 characters.
   - Preserve newline boundaries.
   - Keep the output valid plain text for tool result UI rendering.
3. Collapse 3+ consecutive blank lines into one marker:
   ```text
   [... N blank lines omitted ...]
   ```
4. Collapse consecutive repeated identical lines into:
   ```text
   <line>
   [... repeated N more times ...]
   ```
5. Truncate individual long lines with middle elision:
   ```text
   <prefix>[... N chars omitted ...]<suffix>
   ```
   The prefix/suffix split should favor keeping the line start and end, because terminal lines often put command context at the start and errors/status at the end.
6. If total line count still exceeds `maxLines`, keep a small top context and larger bottom context:
   - top: up to 10 lines
   - bottom: remaining line budget
   - middle marker:
     ```text
     [... N lines omitted ...]
     ```
7. Apply existing UTF-8-safe `maxBytes` as the final hard cap.

### `full`

Compatibility mode. Preserve current behavior: return the full visible screen snapshot in `text`, only constrained by UTF-8-safe `maxBytes` truncation.

Response fields should include `mode: 'full'`, `compressed: false`, `originalBytes`, and `returnedBytes` for observability.

Use this mode for exact TUI layout checks, debugging compression issues, and parity tests that require full visible output.

### `save_file`

Save the full visible-screen snapshot to a local file and return only a compact preview plus path.

Response fields:

```ts
{
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

File behavior:

- Save plain text visible-screen snapshot, not raw PTY bytes.
- Prefer the existing session tool-result storage location if readily reusable; otherwise use a project/session-scoped tool-results path with the same safety properties.
- Use deterministic safe filenames that include the session id and tool use id or timestamp.
- Do not write outside the project/session tool-results area unless existing infrastructure requires it.
- Do not include secrets in logs; the file itself may contain terminal output and should be treated as local sensitive artifact.

Preview behavior:

- `preview` should use the same compact compression pipeline, then UTF-8-safe truncate to `previewBytes`.
- The preview must render cleanly in the existing tool result UI.

## Display correctness requirements

The implementation must guarantee normal display in both model-visible tool result text and user-facing UI rendering:

- No broken Unicode replacement characters from truncation.
- No malformed JSON response fields.
- No raw control characters except ordinary newlines and tabs already present in visible text.
- Omission markers must be plain ASCII and visually obvious.
- `formatToolResultMessage()` must not concatenate large multi-line output into an unreadable single-line summary. It should either keep existing UI behavior for compact text or render concise metadata for `save_file`.
- Existing InteractiveTerminal task preview should continue using `manager.getRenderedPreview()` and should not receive compressed text unless explicitly changed by a separate design.

## Non-goals

- Do not implement raw scrollback export.
- Do not implement cursor-based incremental reads.
- Do not perform model-generated summaries.
- Do not parse ANSI manually; rely on the existing xterm renderer.
- Do not change `open`, `write`, `send_key`, `resize`, `signal`, `status`, `list`, or `close` semantics.
- Do not hide errors or command exit state.

## Testing plan

Focused tests:

1. `handleRead` default mode returns compact metadata and compressed text when the visible screen exceeds budgets.
2. `mode: full` matches current read behavior except for added metadata.
3. `mode: save_file` writes the full visible screen to a local file and returns compact preview plus path.
4. UTF-8 truncation does not split CJK or emoji characters.
5. Repeated lines and blank lines collapse with correct counts.
6. Long lines use middle elision and preserve start/end content.
7. Existing `handleRead returns a screen snapshot and ignores the requested cursor` remains true for `mode: full`, and cursor remains compatibility-only for all modes.
8. UI result formatting displays compact multi-line text normally and displays `save_file` path/preview without flooding the UI.

Verification commands:

```sh
bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts
bun test src/tools/InteractiveTerminalTool/UI.test.ts
bun test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
make build
```

## Recommended implementation shape

Add a small helper near the InteractiveTerminal tool, for example:

```text
src/tools/InteractiveTerminalTool/compressReadOutput.ts
```

Keep it deterministic and independently tested. Avoid new shared abstractions unless another tool immediately reuses the logic.

`handleRead()` should remain the integration point:

1. Get full visible text from `manager.read()`.
2. Compute `originalBytes`.
3. Branch on `mode`.
4. Return structured metadata.
5. Apply UTF-8-safe byte caps last.

## File persistence decision

Implement a narrow InteractiveTerminal-only writer that uses the same session tool-results directory pattern exposed by `src/utils/toolResultStorage.ts`. Avoid calling `persistToolResult()` directly because it is designed for mapped SDK tool result blocks, not explicit `read mode=save_file` behavior. Reuse `ensureToolResultsDir()` and `getToolResultsDir()` if their dependencies are safe in this tool context; otherwise mirror that directory pattern locally with focused tests.
