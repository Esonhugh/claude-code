import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deserializeMessagesWithInterruptDetection,
  findDeferredToolMarker,
} from './conversationRecovery.js'
import type { DeferredToolMarker } from './attachments.js'
import { createAssistantMessage, createUserMessage } from './messages.js'

const marker: DeferredToolMarker = {
  type: 'hook_deferred_tool',
  toolUseID: 'toolu_deferred',
  toolName: 'Bash',
  toolInput: { command: 'echo run' },
  hookName: 'settings',
  hookEvent: 'PreToolUse',
  permissionMode: 'default',
}
const line = (entry: object) => JSON.stringify(entry)
const toolResult = (id: string) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }],
    },
  })

let dir: string
let transcript: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deferred-tool-'))
  transcript = join(dir, 'session.jsonl')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Official 2.1.329: `-p --resume` runs the call a PreToolUse hook deferred.
test('finds the last deferred tool marker that has no result yet', async () => {
  writeFileSync(
    transcript,
    [
      line({ type: 'attachment', attachment: { ...marker, toolUseID: 'toolu_old' } }),
      toolResult('toolu_old'),
      line({ type: 'attachment', attachment: marker }),
      line({ type: 'last-prompt', lastPrompt: 'go' }),
    ].join('\n') + '\n',
  )
  expect(await findDeferredToolMarker(transcript)).toEqual(marker)
})

test('a marker whose call already has a result is stale', async () => {
  writeFileSync(
    transcript,
    [line({ type: 'attachment', attachment: marker }), toolResult('toolu_deferred')].join('\n') + '\n',
  )
  expect(await findDeferredToolMarker(transcript)).toBeNull()
  expect(await findDeferredToolMarker(join(dir, 'missing.jsonl'))).toBeNull()
})

test('resume keeps the deferred call open instead of dropping it as unresolved', () => {
  const block = {
    type: 'tool_use' as const,
    id: 'toolu_deferred',
    name: 'Bash',
    input: { command: 'echo run' },
  }
  const messages = [
    createUserMessage({ content: 'go' }),
    createAssistantMessage({ content: [block] }),
  ]
  // Without a marker the open call counts as interrupted and is answered.
  expect(
    JSON.stringify(deserializeMessagesWithInterruptDetection(messages).messages),
  ).toContain('"tool_use_id":"toolu_deferred"')
  const kept = deserializeMessagesWithInterruptDetection(
    messages,
    new Set(['toolu_deferred']),
  )
  expect(JSON.stringify(kept.messages)).not.toContain('tool_result')
  expect(kept.messages.at(-1)).toMatchObject({
    type: 'assistant',
    message: { content: [block] },
  })
  expect(kept.turnInterruptionState).toEqual({ kind: 'none' })
})
