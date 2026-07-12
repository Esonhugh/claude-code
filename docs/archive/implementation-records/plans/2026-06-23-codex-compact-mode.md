# Codex Compact Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings-controlled `compact.mode = "codex"` path that produces smaller Codex-style compact results without changing default Claude compact behavior.

**Architecture:** Keep the existing Message[] compact architecture and add a focused Codex-style projection layer. A small settings resolver controls manual and auto compact branching; the Codex-style service reuses existing summary generation but builds a leaner `CompactionResult` with retained recent messages, reduced attachments, tool-output truncation, and metadata for validation.

**Tech Stack:** TypeScript, Bun, Zod settings schema, existing compact services in `src/services/compact`, existing settings loader in `src/utils/settings`.

---

## File Structure

Create or modify these files only:

- Modify: `src/utils/settings/types.ts`
  - Add optional `compact` settings schema.
- Create: `src/services/compact/compactMode.ts`
  - Resolve `claude | codex` mode and Codex options from settings.
- Create: `src/services/compact/codexCompact.ts`
  - Implement Codex-style compact result builder and helper functions.
- Modify: `src/commands/compact/compact.ts`
  - Route manual `/compact` to Codex mode when configured.
- Modify: `src/services/compact/autoCompact.ts`
  - Route auto compact to Codex mode when configured and skip session memory compact in Codex mode.
- Create: `src/services/compact/compactMode.test.ts`
  - Unit tests for mode resolution.
- Create: `src/services/compact/codexCompact.test.ts`
  - Unit tests for retained messages, tool output truncation, metadata, and attachment reduction.
- Create: `src/utils/settings/compactSettings.test.ts`
  - Unit tests for settings schema validation.

Do not restructure `src/services/compact/compact.ts` beyond exports needed by the new service. Do not change transcript or resume storage.

---

### Task 1: Add compact settings schema

**Files:**
- Modify: `src/utils/settings/types.ts:257`
- Test: `src/utils/settings/compactSettings.test.ts`

- [ ] **Step 1: Write the failing settings schema test**

Create `src/utils/settings/compactSettings.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

describe('compact settings schema', () => {
  test('accepts codex compact mode with options', () => {
    const result = SettingsSchema().safeParse({
      compact: {
        mode: 'codex',
        codex: {
          retainedUserMessageTokens: 20000,
          keepPostCompactAttachments: false,
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compact?.mode).toBe('codex')
    expect(result.data.compact?.codex?.retainedUserMessageTokens).toBe(20000)
    expect(result.data.compact?.codex?.keepPostCompactAttachments).toBe(false)
  })

  test('rejects unsupported compact mode', () => {
    const result = SettingsSchema().safeParse({
      compact: {
        mode: 'openai',
      },
    })

    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the settings schema test and verify it fails**

Run:

```bash
bun test src/utils/settings/compactSettings.test.ts
```

Expected: FAIL because `SettingsSchema` does not expose `compact` with the expected type yet.

- [ ] **Step 3: Add the compact schema**

In `src/utils/settings/types.ts`, inside the `SettingsSchema` object near other top-level preferences such as `model`, add:

```ts
      compact: z
        .object({
          mode: z
            .enum(['claude', 'codex'])
            .optional()
            .describe(
              'Compact strategy. "claude" keeps the default Claude Code compact behavior; "codex" enables Codex-style compact projection.',
            ),
          codex: z
            .object({
              retainedUserMessageTokens: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                  'Approximate token budget for recent user messages retained by Codex-style compact mode.',
                ),
              keepPostCompactAttachments: z
                .boolean()
                .optional()
                .describe(
                  'When true, Codex-style compact keeps the existing post-compact attachment rehydration behavior.',
                ),
            })
            .optional()
            .describe('Codex-style compact options.'),
        })
        .optional()
        .describe('Conversation compact strategy configuration'),
```

- [ ] **Step 4: Run the settings schema test and verify it passes**

Run:

```bash
bun test src/utils/settings/compactSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck for changed schema**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

---

### Task 2: Add compact mode resolver

**Files:**
- Create: `src/services/compact/compactMode.ts`
- Test: `src/services/compact/compactMode.test.ts`

- [ ] **Step 1: Write the failing resolver test**

Create `src/services/compact/compactMode.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS,
  getCompactModeFromSettings,
  getCodexCompactOptionsFromSettings,
} from './compactMode.js'

describe('compact mode resolver', () => {
  test('defaults to claude mode when settings are empty', () => {
    expect(getCompactModeFromSettings({})).toBe('claude')
  })

  test('returns codex mode when explicitly configured', () => {
    expect(
      getCompactModeFromSettings({
        compact: { mode: 'codex' },
      }),
    ).toBe('codex')
  })

  test('returns codex defaults when codex options are omitted', () => {
    expect(
      getCodexCompactOptionsFromSettings({
        compact: { mode: 'codex' },
      }),
    ).toEqual({
      retainedUserMessageTokens:
        DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS,
      keepPostCompactAttachments: false,
    })
  })

  test('returns configured codex options', () => {
    expect(
      getCodexCompactOptionsFromSettings({
        compact: {
          mode: 'codex',
          codex: {
            retainedUserMessageTokens: 12000,
            keepPostCompactAttachments: true,
          },
        },
      }),
    ).toEqual({
      retainedUserMessageTokens: 12000,
      keepPostCompactAttachments: true,
    })
  })
})
```

- [ ] **Step 2: Run the resolver test and verify it fails**

Run:

```bash
bun test src/services/compact/compactMode.test.ts
```

Expected: FAIL because `compactMode.ts` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `src/services/compact/compactMode.ts`:

```ts
import type { SettingsJson } from '../../utils/settings/types.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export type CompactMode = 'claude' | 'codex'

export const DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS = 20_000

export type CodexCompactOptions = {
  retainedUserMessageTokens: number
  keepPostCompactAttachments: boolean
}

export function getCompactModeFromSettings(settings: SettingsJson): CompactMode {
  return settings.compact?.mode === 'codex' ? 'codex' : 'claude'
}

export function getCompactMode(): CompactMode {
  return getCompactModeFromSettings(getInitialSettings())
}

export function getCodexCompactOptionsFromSettings(
  settings: SettingsJson,
): CodexCompactOptions {
  return {
    retainedUserMessageTokens:
      settings.compact?.codex?.retainedUserMessageTokens ??
      DEFAULT_CODEX_COMPACT_RETAINED_USER_MESSAGE_TOKENS,
    keepPostCompactAttachments:
      settings.compact?.codex?.keepPostCompactAttachments ?? false,
  }
}

export function getCodexCompactOptions(): CodexCompactOptions {
  return getCodexCompactOptionsFromSettings(getInitialSettings())
}
```

- [ ] **Step 4: Run resolver and schema tests**

Run:

```bash
bun test src/services/compact/compactMode.test.ts src/utils/settings/compactSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

---

### Task 3: Implement Codex-style helper functions

**Files:**
- Create: `src/services/compact/codexCompact.ts`
- Test: `src/services/compact/codexCompact.test.ts`

- [ ] **Step 1: Write failing tests for tool output truncation and retained metadata**

Create `src/services/compact/codexCompact.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT,
  buildCodexCompactMetadata,
  truncateLargeToolResultsForCodexCompact,
} from './codexCompact.js'

function userToolResultMessage(content: string): Message {
  return {
    type: 'user',
    uuid: 'user-tool-result',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content,
        },
      ],
    },
    toolUseResult: content,
  } as Message
}

describe('codex compact helpers', () => {
  test('truncates large text tool_result bodies', () => {
    const large = 'x'.repeat(120_000)
    const [message] = truncateLargeToolResultsForCodexCompact([
      userToolResultMessage(large),
    ])

    expect(message?.type).toBe('user')
    if (message?.type !== 'user') return
    const content = message.message.content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    const block = content[0]
    expect(block?.type).toBe('tool_result')
    if (block?.type !== 'tool_result') return
    expect(block.tool_use_id).toBe('toolu_1')
    expect(block.content).toBe(CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT)
  })

  test('does not truncate small tool_result bodies', () => {
    const small = 'small output'
    const [message] = truncateLargeToolResultsForCodexCompact([
      userToolResultMessage(small),
    ])

    expect(message?.type).toBe('user')
    if (message?.type !== 'user') return
    const content = message.message.content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    const block = content[0]
    expect(block?.type).toBe('tool_result')
    if (block?.type !== 'tool_result') return
    expect(block.content).toBe(small)
  })

  test('builds codex compact metadata', () => {
    expect(
      buildCodexCompactMetadata({
        retainedMessageCount: 3,
        retainedApproxTokens: 1234,
        truncatedToolResultCount: 2,
        droppedAttachmentCount: 4,
        retainedUserMessageTokens: 20000,
      }),
    ).toEqual({
      mode: 'codex',
      retainedMessageCount: 3,
      retainedApproxTokens: 1234,
      truncatedToolResultCount: 2,
      droppedAttachmentCount: 4,
      retainedUserMessageTokens: 20000,
    })
  })
})
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: FAIL because `codexCompact.ts` does not exist.

- [ ] **Step 3: Implement helper exports**

Create `src/services/compact/codexCompact.ts` with these initial helpers:

```ts
import type { Message } from '../../types/message.js'

export const CODEX_COMPACT_TOOL_RESULT_TRUNCATION_THRESHOLD_CHARS = 32_000
export const CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT =
  '[tool output truncated during codex-style compaction]'

export type CodexCompactMetadata = {
  mode: 'codex'
  retainedMessageCount: number
  retainedApproxTokens: number
  truncatedToolResultCount: number
  droppedAttachmentCount: number
  retainedUserMessageTokens: number
}

export function buildCodexCompactMetadata(input: {
  retainedMessageCount: number
  retainedApproxTokens: number
  truncatedToolResultCount: number
  droppedAttachmentCount: number
  retainedUserMessageTokens: number
}): CodexCompactMetadata {
  return {
    mode: 'codex',
    retainedMessageCount: input.retainedMessageCount,
    retainedApproxTokens: input.retainedApproxTokens,
    truncatedToolResultCount: input.truncatedToolResultCount,
    droppedAttachmentCount: input.droppedAttachmentCount,
    retainedUserMessageTokens: input.retainedUserMessageTokens,
  }
}

export function truncateLargeToolResultsForCodexCompact(
  messages: Message[],
): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    if (!Array.isArray(message.message.content)) return message

    let changed = false
    const content = message.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content !== 'string') return block
      if (
        block.content.length <= CODEX_COMPACT_TOOL_RESULT_TRUNCATION_THRESHOLD_CHARS
      ) {
        return block
      }
      changed = true
      return {
        ...block,
        content: CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT,
      }
    })

    if (!changed) return message

    return {
      ...message,
      message: {
        ...message.message,
        content,
      },
      toolUseResult:
        typeof message.toolUseResult === 'string' &&
        message.toolUseResult.length >
          CODEX_COMPACT_TOOL_RESULT_TRUNCATION_THRESHOLD_CHARS
          ? CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT
          : message.toolUseResult,
    } as Message
  })
}

export function countTruncatedToolResults(
  before: Message[],
  after: Message[],
): number {
  let count = 0
  for (let i = 0; i < before.length; i++) {
    const oldMessage = before[i]
    const newMessage = after[i]
    if (oldMessage?.type !== 'user' || newMessage?.type !== 'user') continue
    if (
      !Array.isArray(oldMessage.message.content) ||
      !Array.isArray(newMessage.message.content)
    ) {
      continue
    }
    for (let j = 0; j < oldMessage.message.content.length; j++) {
      const oldBlock = oldMessage.message.content[j]
      const newBlock = newMessage.message.content[j]
      if (
        oldBlock?.type === 'tool_result' &&
        newBlock?.type === 'tool_result' &&
        typeof oldBlock.content === 'string' &&
        oldBlock.content !== newBlock.content &&
        newBlock.content === CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT
      ) {
        count++
      }
    }
  }
  return count
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

---

### Task 4: Add retained recent message selection

**Files:**
- Modify: `src/services/compact/codexCompact.ts`
- Test: `src/services/compact/codexCompact.test.ts`

- [ ] **Step 1: Add failing tests for retained messages**

Append to `src/services/compact/codexCompact.test.ts`:

```ts
import { selectRetainedMessagesForCodexCompact } from './codexCompact.js'

function userTextMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: text,
    },
  } as Message
}

function assistantToolUseMessage(uuid: string, id: string): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: '/tmp/example.txt' },
        },
      ],
    },
  } as Message
}

function matchingToolResultMessage(uuid: string, id: string): Message {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: 'result',
        },
      ],
    },
  } as Message
}

describe('selectRetainedMessagesForCodexCompact', () => {
  test('keeps recent user messages within approximate budget', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage('old', 'a'.repeat(1000)),
        userTextMessage('new', 'recent'),
      ],
      10,
    )

    expect(result.messages.map(m => m.uuid)).toEqual(['new'])
    expect(result.approxTokens).toBeGreaterThan(0)
  })

  test('keeps a tool_use with its matching tool_result when retaining the result', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage('old', 'old'),
        assistantToolUseMessage('assistant-tool', 'toolu_1'),
        matchingToolResultMessage('tool-result', 'toolu_1'),
        userTextMessage('follow-up', 'continue'),
      ],
      2000,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      'assistant-tool',
      'tool-result',
      'follow-up',
    ])
  })
})
```

- [ ] **Step 2: Run the retained message tests and verify they fail**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: FAIL because `selectRetainedMessagesForCodexCompact` is not implemented.

- [ ] **Step 3: Implement retained message selection**

Append to `src/services/compact/codexCompact.ts`:

```ts
function approximateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function approximateMessageTokens(message: Message): number {
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') return approximateTextTokens(content)
    if (Array.isArray(content)) {
      return content.reduce((sum, block) => {
        if ('text' in block && typeof block.text === 'string') {
          return sum + approximateTextTokens(block.text)
        }
        if ('content' in block && typeof block.content === 'string') {
          return sum + approximateTextTokens(block.content)
        }
        return sum + 10
      }, 0)
    }
  }
  if (message.type === 'assistant' && Array.isArray(message.message.content)) {
    return message.message.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + approximateTextTokens(block.text)
      return sum + 10
    }, 0)
  }
  return 10
}

function toolUseIdsInMessage(message: Message): string[] {
  if (message.type !== 'assistant') return []
  if (!Array.isArray(message.message.content)) return []
  return message.message.content.flatMap(block =>
    block.type === 'tool_use' ? [block.id] : [],
  )
}

function toolResultIdsInMessage(message: Message): string[] {
  if (message.type !== 'user') return []
  if (!Array.isArray(message.message.content)) return []
  return message.message.content.flatMap(block =>
    block.type === 'tool_result' ? [block.tool_use_id] : [],
  )
}

export function selectRetainedMessagesForCodexCompact(
  messages: Message[],
  retainedUserMessageTokens: number,
): { messages: Message[]; approxTokens: number } {
  const selected = new Set<number>()
  let tokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    const messageTokens = approximateMessageTokens(message)
    if (tokens > 0 && tokens + messageTokens > retainedUserMessageTokens) {
      break
    }
    selected.add(i)
    tokens += messageTokens

    for (const toolResultId of toolResultIdsInMessage(message)) {
      for (let j = i - 1; j >= 0; j--) {
        if (toolUseIdsInMessage(messages[j]!).includes(toolResultId)) {
          if (!selected.has(j)) {
            selected.add(j)
            tokens += approximateMessageTokens(messages[j]!)
          }
          break
        }
      }
    }
  }

  const retained = [...selected]
    .sort((a, b) => a - b)
    .map(index => messages[index]!)

  return { messages: retained, approxTokens: tokens }
}
```

- [ ] **Step 4: Run compact helper tests**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

---

### Task 5: Implement Codex-style compact service

**Files:**
- Modify: `src/services/compact/codexCompact.ts`
- Modify: `src/services/compact/compact.ts`
- Test: `src/services/compact/codexCompact.test.ts`

- [ ] **Step 1: Add failing test for Codex-style CompactionResult shape**

Append to `src/services/compact/codexCompact.test.ts`:

```ts
import { buildCodexStyleCompactionResult } from './codexCompact.js'

describe('buildCodexStyleCompactionResult', () => {
  test('orders boundary, retained messages, summary, and minimal attachments', () => {
    const boundary = {
      type: 'system',
      uuid: 'boundary',
      isMeta: true,
      compactMetadata: {},
      content: 'compact boundary',
    } as Message
    const retained = [userTextMessage('retained', 'recent task')]
    const summary = [
      {
        type: 'user',
        uuid: 'summary',
        isCompactSummary: true,
        message: { role: 'user', content: 'summary' },
      } as Message,
    ]
    const hook = {
      type: 'system',
      uuid: 'hook',
      content: 'hook',
    } as Message

    const result = buildCodexStyleCompactionResult({
      boundaryMarker: boundary,
      summaryMessages: summary as never,
      retainedMessages: retained,
      minimalAttachments: [],
      hookResults: [hook] as never,
      preCompactTokenCount: 1000,
      postCompactTokenCount: 100,
      truePostCompactTokenCount: 100,
      metadata: buildCodexCompactMetadata({
        retainedMessageCount: 1,
        retainedApproxTokens: 3,
        truncatedToolResultCount: 0,
        droppedAttachmentCount: 2,
        retainedUserMessageTokens: 20000,
      }),
    })

    expect([
      result.boundaryMarker,
      ...(result.messagesToKeep ?? []),
      ...result.summaryMessages,
      ...result.attachments,
      ...result.hookResults,
    ].map(message => message.uuid)).toEqual(['boundary', 'retained', 'summary', 'hook'])
    expect(result.boundaryMarker.compactMetadata.mode).toBe('codex')
  })
})
```

- [ ] **Step 2: Run the shape test and verify it fails**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: FAIL because `buildCodexStyleCompactionResult` is not implemented.

- [ ] **Step 3: Export attachment helpers needed by Codex service**

In `src/services/compact/compact.ts`, export these existing functions if they are not already exported:

```ts
export async function createPostCompactFileAttachments(
```

Keep the function body unchanged. If `createAsyncAgentAttachmentsIfNeeded`, `createPlanAttachmentIfNeeded`, `createPlanModeAttachmentIfNeeded`, or `createSkillAttachmentIfNeeded` are needed and not exported, do not export them for MVP. Codex mode should start with no file/skill/agent attachments unless `keepPostCompactAttachments` is true and can reuse `compactConversation()` in a later task.

- [ ] **Step 4: Implement CompactionResult builder**

Append to `src/services/compact/codexCompact.ts`:

```ts
import type {
  AttachmentMessage,
  HookResultMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { CompactionResult } from './compact.js'

export function buildCodexStyleCompactionResult(input: {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  retainedMessages: Message[]
  minimalAttachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  metadata: CodexCompactMetadata
}): CompactionResult {
  return {
    boundaryMarker: {
      ...input.boundaryMarker,
      compactMetadata: {
        // @ts-ignore recovered compact metadata is structurally wider than the public type
        ...input.boundaryMarker.compactMetadata,
        ...input.metadata,
      },
    } as SystemMessage,
    summaryMessages: input.summaryMessages,
    messagesToKeep: input.retainedMessages,
    attachments: input.minimalAttachments,
    hookResults: input.hookResults,
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount: input.truePostCompactTokenCount,
  }
}
```

- [ ] **Step 5: Run compact helper tests**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

---

### Task 6: Add `compactConversationCodexStyle`

**Files:**
- Modify: `src/services/compact/codexCompact.ts`
- Modify: `src/services/compact/compact.ts`
- Test: `src/services/compact/codexCompact.test.ts`

- [ ] **Step 1: Add a failing test for the high-level service with injected summary pieces**

Append to `src/services/compact/codexCompact.test.ts`:

```ts
import { createCodexStyleCompactionResultFromSummary } from './codexCompact.js'

describe('createCodexStyleCompactionResultFromSummary', () => {
  test('truncates large tool output, retains recent messages, and records metadata', () => {
    const messages = [
      userTextMessage('old', 'old context '.repeat(2000)),
      userToolResultMessage('x'.repeat(120_000)),
      userTextMessage('recent', 'current task'),
    ]
    const boundary = {
      type: 'system',
      uuid: 'boundary',
      isMeta: true,
      compactMetadata: {},
      content: 'compact boundary',
    } as Message
    const summaryMessages = [
      {
        type: 'user',
        uuid: 'summary',
        isCompactSummary: true,
        message: { role: 'user', content: 'summary' },
      } as Message,
    ]

    const result = createCodexStyleCompactionResultFromSummary({
      originalMessages: messages,
      boundaryMarker: boundary as never,
      summaryMessages: summaryMessages as never,
      hookResults: [],
      options: {
        retainedUserMessageTokens: 20000,
        keepPostCompactAttachments: false,
      },
      preCompactTokenCount: 50000,
      postCompactTokenCount: 1000,
    })

    expect(result.attachments).toEqual([])
    expect(result.boundaryMarker.compactMetadata.mode).toBe('codex')
    expect(result.boundaryMarker.compactMetadata.truncatedToolResultCount).toBe(1)
    expect(result.messagesToKeep?.some(m => m.uuid === 'recent')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: FAIL because `createCodexStyleCompactionResultFromSummary` is not implemented.

- [ ] **Step 3: Implement summary-to-result service**

Append to `src/services/compact/codexCompact.ts`:

```ts
import type { CodexCompactOptions } from './compactMode.js'

export function createCodexStyleCompactionResultFromSummary(input: {
  originalMessages: Message[]
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  hookResults: HookResultMessage[]
  options: CodexCompactOptions
  preCompactTokenCount?: number
  postCompactTokenCount?: number
}): CompactionResult {
  const truncatedMessages = truncateLargeToolResultsForCodexCompact(
    input.originalMessages,
  )
  const truncatedToolResultCount = countTruncatedToolResults(
    input.originalMessages,
    truncatedMessages,
  )
  const retained = selectRetainedMessagesForCodexCompact(
    truncatedMessages,
    input.options.retainedUserMessageTokens,
  )
  const metadata = buildCodexCompactMetadata({
    retainedMessageCount: retained.messages.length,
    retainedApproxTokens: retained.approxTokens,
    truncatedToolResultCount,
    droppedAttachmentCount: input.options.keepPostCompactAttachments ? 0 : -1,
    retainedUserMessageTokens: input.options.retainedUserMessageTokens,
  })

  return buildCodexStyleCompactionResult({
    boundaryMarker: input.boundaryMarker,
    summaryMessages: input.summaryMessages,
    retainedMessages: retained.messages,
    minimalAttachments: [],
    hookResults: input.hookResults,
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount:
      (input.postCompactTokenCount ?? 0) + retained.approxTokens,
    metadata,
  })
}
```

- [ ] **Step 4: Run Codex compact tests**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

---

### Task 7: Wire manual `/compact` mode routing

**Files:**
- Modify: `src/commands/compact/compact.ts:55-108`
- Modify: `src/services/compact/codexCompact.ts`
- Test: existing Bun tests from prior tasks

- [ ] **Step 1: Add the manual routing imports**

In `src/commands/compact/compact.ts`, add imports:

```ts
import { getCompactMode, getCodexCompactOptions } from '../../services/compact/compactMode.js'
import { compactConversationCodexStyle } from '../../services/compact/codexCompact.js'
```

- [ ] **Step 2: Implement `compactConversationCodexStyle` by wrapping current summary flow**

In `src/services/compact/codexCompact.ts`, add this exported function signature:

```ts
import type { ToolUseContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../services/api/claude.js'
import {
  compactConversation,
  createCompactBoundaryMessage,
} from './compact.js'

export async function compactConversationCodexStyle(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions: string | undefined,
  isAutoCompact: boolean,
  options: CodexCompactOptions,
): Promise<CompactionResult> {
  const claudeResult = await compactConversation(
    messages,
    context,
    cacheSafeParams,
    suppressFollowUpQuestions,
    customInstructions,
    isAutoCompact,
  )

  const boundaryMarker = createCompactBoundaryMessage(
    isAutoCompact ? 'auto' : 'manual',
    claudeResult.preCompactTokenCount ?? 0,
    messages.at(-1)?.uuid,
  )

  return createCodexStyleCompactionResultFromSummary({
    originalMessages: messages,
    boundaryMarker,
    summaryMessages: claudeResult.summaryMessages,
    hookResults: claudeResult.hookResults,
    options,
    preCompactTokenCount: claudeResult.preCompactTokenCount,
    postCompactTokenCount: claudeResult.postCompactTokenCount,
  })
}
```

If `createCompactBoundaryMessage` is not exported from `compact.ts`, export it without changing its body.

- [ ] **Step 3: Route manual compact before session memory compact**

In `src/commands/compact/compact.ts`, after `const customInstructions = args.trim()`, add:

```ts
    const compactMode = getCompactMode()
```

Change the session memory block condition from:

```ts
    if (!customInstructions) {
```

to:

```ts
    if (compactMode === 'claude' && !customInstructions) {
```

This implements the design decision that Codex mode skips session memory compact in MVP.

- [ ] **Step 4: Route the traditional compaction call**

Replace the current `const result = await compactConversation(...)` block in `src/commands/compact/compact.ts` with:

```ts
    const result =
      compactMode === 'codex'
        ? await compactConversationCodexStyle(
            messagesForCompact,
            context,
            await getCacheSharingParams(context, messagesForCompact),
            false,
            customInstructions,
            false,
            getCodexCompactOptions(),
          )
        : await compactConversation(
            messagesForCompact,
            context,
            await getCacheSharingParams(context, messagesForCompact),
            false,
            customInstructions,
            false,
          )
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun test src/services/compact/compactMode.test.ts src/services/compact/codexCompact.test.ts src/utils/settings/compactSettings.test.ts
bun tsc --noEmit
```

Expected: PASS.

---

### Task 8: Wire auto compact mode routing

**Files:**
- Modify: `src/services/compact/autoCompact.ts:287-321`
- Test: existing Bun tests from prior tasks

- [ ] **Step 1: Add auto compact imports**

In `src/services/compact/autoCompact.ts`, add imports:

```ts
import { getCompactMode, getCodexCompactOptions } from './compactMode.js'
import { compactConversationCodexStyle } from './codexCompact.js'
```

- [ ] **Step 2: Resolve compact mode before session memory compact**

Before the session memory compact block, add:

```ts
  const compactMode = getCompactMode()
```

- [ ] **Step 3: Skip session memory compact in Codex mode**

Wrap the existing session memory compact block in:

```ts
  if (compactMode === 'claude') {
    const sessionMemoryResult = await trySessionMemoryCompaction(
      messages,
      toolUseContext.agentId,
      recompactionInfo.autoCompactThreshold,
    )
    if (sessionMemoryResult) {
      setLastSummarizedMessageId(undefined)
      runPostCompactCleanup(querySource)
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
      }
      markPostCompaction()
      return {
        wasCompacted: true,
        compactionResult: sessionMemoryResult,
      }
    }
  }
```

Delete the now-duplicated unguarded session memory block.

- [ ] **Step 4: Route legacy compact call**

Replace:

```ts
    const compactionResult = await compactConversation(
```

with:

```ts
    const compactionResult =
      compactMode === 'codex'
        ? await compactConversationCodexStyle(
            messages,
            toolUseContext,
            cacheSafeParams,
            true,
            undefined,
            true,
            getCodexCompactOptions(),
          )
        : await compactConversation(
            messages,
            toolUseContext,
            cacheSafeParams,
            true,
            undefined,
            true,
            recompactionInfo,
          )
```

Ensure the old closing arguments from the original `compactConversation(...)` call are removed so the expression is syntactically valid.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun test src/services/compact/compactMode.test.ts src/services/compact/codexCompact.test.ts src/utils/settings/compactSettings.test.ts
bun tsc --noEmit
```

Expected: PASS.

---

### Task 9: Add metadata and telemetry consistency

**Files:**
- Modify: `src/services/compact/codexCompact.ts`
- Test: `src/services/compact/codexCompact.test.ts`

- [ ] **Step 1: Add failing metadata test for dropped attachments**

Append to `src/services/compact/codexCompact.test.ts`:

```ts
describe('codex compact attachment metadata', () => {
  test('records zero dropped attachments when attachment compatibility is enabled', () => {
    const result = createCodexStyleCompactionResultFromSummary({
      originalMessages: [userTextMessage('recent', 'current task')],
      boundaryMarker: {
        type: 'system',
        uuid: 'boundary',
        isMeta: true,
        compactMetadata: {},
        content: 'compact boundary',
      } as never,
      summaryMessages: [
        {
          type: 'user',
          uuid: 'summary',
          isCompactSummary: true,
          message: { role: 'user', content: 'summary' },
        } as never,
      ],
      hookResults: [],
      options: {
        retainedUserMessageTokens: 20000,
        keepPostCompactAttachments: true,
      },
      preCompactTokenCount: 100,
      postCompactTokenCount: 10,
    })

    expect(result.boundaryMarker.compactMetadata.droppedAttachmentCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run the metadata test**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
```

Expected: PASS if Task 6 already sets this correctly; if it fails because `droppedAttachmentCount` is `-1`, continue to Step 3.

- [ ] **Step 3: Replace placeholder dropped attachment count**

In `createCodexStyleCompactionResultFromSummary`, replace:

```ts
    droppedAttachmentCount: input.options.keepPostCompactAttachments ? 0 : -1,
```

with:

```ts
    droppedAttachmentCount: 0,
```

For MVP, do not claim an unknown dropped count. Attachment count can be added once Codex mode explicitly computes skipped attachments.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
bun test src/services/compact/codexCompact.test.ts
bun tsc --noEmit
```

Expected: PASS.

---

### Task 10: Run full local validation

**Files:**
- No source changes unless validation reveals failures.

- [ ] **Step 1: Run all new tests**

Run:

```bash
bun test src/services/compact/compactMode.test.ts src/services/compact/codexCompact.test.ts src/utils/settings/compactSettings.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Build the local binary**

Run:

```bash
make build
```

Expected: `./built-claude` exists.

- [ ] **Step 5: Prepare local settings for interactive verification**

Create or update `.claude/settings.local.json` only after checking whether it already exists. If it exists, preserve unrelated keys and add:

```json
{
  "compact": {
    "mode": "codex"
  }
}
```

- [ ] **Step 6: Start interactive CLI with InteractiveTerminal**

Open a session with command:

```bash
./built-claude --dangerously-skip-permissions
```

Expected: Claude Code prompt appears.

- [ ] **Step 7: Run compact continuity scenario**

Send this prompt:

```text
请读取 src/services/compact/compact.ts，然后总结它的 compact 流程，接着我会要求你继续修改。
```

After it answers, send:

```text
/compact
```

After compact completes, send:

```text
刚才你读过的 compact 流程里，post-compact attachments 是在哪里创建的？
```

Expected: The model preserves task intent and can identify the compact file/flow. It may ask to reread the file for exact lines; it must not lose the topic completely.

- [ ] **Step 8: Restore local settings**

Remove the temporary `compact.mode` key from `.claude/settings.local.json` unless the user explicitly wants to keep it.

- [ ] **Step 9: Review git diff**

Run:

```bash
git status --short
git diff -- src/utils/settings/types.ts src/services/compact/compactMode.ts src/services/compact/codexCompact.ts src/commands/compact/compact.ts src/services/compact/autoCompact.ts src/services/compact/compactMode.test.ts src/services/compact/codexCompact.test.ts src/utils/settings/compactSettings.test.ts docs/superpowers/plans/2026-06-23-codex-compact-mode.md
```

Expected: Only planned files changed. No temporary settings changes remain unless user requested them.

---

## Self-Review Notes

- Spec coverage: settings schema, mode resolver, manual compact, auto compact, session memory skip in Codex mode, tool output truncation, retained messages, metadata, tests, and local interactive verification are all covered.
- Scope control: true Codex `replacement_history`, remote compact, and `new_context` remain out of scope.
- Type consistency: the plan consistently uses `CompactMode`, `CodexCompactOptions`, `compactConversationCodexStyle`, `createCodexStyleCompactionResultFromSummary`, and `selectRetainedMessagesForCodexCompact`.
- Repository constraint: do not create git commits unless the user explicitly approves. The task steps intentionally omit commit steps.
