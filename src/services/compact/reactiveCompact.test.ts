import { afterEach, expect, spyOn, test } from 'bun:test'
import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../api/errors.js'
import * as autoCompact from './autoCompact.js'
import {
  isReactiveCompactEnabled,
  isWithheldPromptTooLong,
  singleExchangePromptTooLong,
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

test('a prompt-too-long on a single exchange is reported instead of compacted, like official', () => {
  const user = (content: string) =>
    ({ type: 'user', message: { role: 'user', content } }) as never
  const assistant = (id: string) =>
    ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'ok' }] } }) as never
  const refused = (errorDetails?: string) =>
    createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails,
    })
  const textOf = (message: ReturnType<typeof singleExchangePromptTooLong>) =>
    (message?.message.content as Array<{ text: string }>)[0]!.text
  const details = 'prompt is too long: 250000 tokens > 200000 maximum'

  expect(textOf(singleExchangePromptTooLong(refused(details), [user('hi')]))).toBe(
    'Prompt is too long · the request is ~250000 tokens (limit 200000) but this conversation is only ~1 tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.',
  )
  expect(
    textOf(singleExchangePromptTooLong(refused('prompt is too long: 10 tokens > 5 maximum'), [user('x'.repeat(400))])),
  ).toBe(
    "Prompt is too long · the request is ~10 tokens (limit 5) and this conversation's own content is most of it. A single-exchange conversation cannot be compacted; start with less content (smaller files or pasted text).",
  )
  expect(textOf(singleExchangePromptTooLong(refused(), [user('hi')]))).toBe(
    'Prompt is too long · this conversation is a single exchange and cannot be compacted — the request size comes mostly from system prompt, tool definitions, or attachments.',
  )
  const kept = singleExchangePromptTooLong(refused(details), [user('hi')])!
  expect(kept.errorDetails).toBe(details)
  expect(isWithheldPromptTooLong(kept)).toBe(isReactiveCompactEnabled())
  // A second API round gives compaction something to summarize.
  expect(
    singleExchangePromptTooLong(refused(details), [user('hi'), assistant('a'), user('result'), assistant('b')]),
  ).toBeNull()
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
