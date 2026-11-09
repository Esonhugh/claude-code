import { afterEach, expect, spyOn, test } from 'bun:test'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../api/errors.js'
import * as autoCompact from './autoCompact.js'
import {
  isReactiveCompactEnabled,
  isWithheldPromptTooLong,
  tryReactiveCompact,
} from './reactiveCompact.js'

const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

const ptl = createAssistantAPIErrorMessage({
  content: PROMPT_TOO_LONG_ERROR_MESSAGE,
  error: 'invalid_request',
})
const cacheSafeParams = { toolUseContext: {} } as never

test('prompt-too-long is withheld for recovery while auto-compact is on', () => {
  const enabled = spyOn(autoCompact, 'isAutoCompactEnabled').mockReturnValue(true)
  restores.push(() => enabled.mockRestore())
  expect(isReactiveCompactEnabled()).toBe(true)
  expect(isWithheldPromptTooLong(ptl)).toBe(true)
  expect(
    isWithheldPromptTooLong(
      createAssistantAPIErrorMessage({ content: 'API Error: other', error: 'unknown' }),
    ),
  ).toBe(false)
})

test('prompt-too-long is not withheld when auto-compact is off', () => {
  const enabled = spyOn(autoCompact, 'isAutoCompactEnabled').mockReturnValue(false)
  restores.push(() => enabled.mockRestore())
  expect(isWithheldPromptTooLong(ptl)).toBe(false)
})

test('compacts once and returns the result', async () => {
  const result = { boundaryMarker: {} } as never
  const run = spyOn(autoCompact, 'autoCompactIfNeeded').mockResolvedValue({
    wasCompacted: true,
    compactionResult: result,
  })
  restores.push(() => run.mockRestore())
  const messages = [ptl]
  expect(
    await tryReactiveCompact({
      hasAttempted: false,
      querySource: 'sdk',
      messages,
      cacheSafeParams,
    }),
  ).toBe(result)
  const call = run.mock.calls[0]!
  expect(call[0]).toBe(messages)
  expect(call[3]).toBe('sdk')
  expect(call.at(-1)).toBe(true)
})

test.each([
  ['an earlier attempt', { hasAttempted: true }],
  ['an abort', { aborted: true }],
  ['the compact request itself', { querySource: 'compact' }],
  ['a session-memory fork', { querySource: 'session_memory' }],
])('does not compact after %s', async (_name, extra) => {
  const run = spyOn(autoCompact, 'autoCompactIfNeeded')
  restores.push(() => run.mockRestore())
  expect(
    await tryReactiveCompact({
      hasAttempted: false,
      messages: [ptl],
      cacheSafeParams,
      ...extra,
    }),
  ).toBeNull()
  expect(run).not.toHaveBeenCalled()
})

test('returns null when compaction fails', async () => {
  const run = spyOn(autoCompact, 'autoCompactIfNeeded').mockResolvedValue({
    wasCompacted: false,
    consecutiveFailures: 1,
  })
  restores.push(() => run.mockRestore())
  expect(
    await tryReactiveCompact({ hasAttempted: false, messages: [ptl], cacheSafeParams }),
  ).toBeNull()
})
