import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { AssistantMessage, StreamEvent } from '../../types/message.js'
import { createModTurnCompletion } from './turnAdapter.js'
import type { ModSnapshot } from './runtime.js'
import { dispatchModEvent } from './dispatch.js'

const end = { durationMs: 12, aborted: false, failed: false, terminal: { reason: 'completed' } }
function response(id: string, text: string): AssistantMessage {
  return {
    type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: { id, role: 'assistant', model: 'actual-model', content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 } },
  }
}
function snapshot(hook?: (input: any, next: any) => Promise<unknown>, failures: unknown[] = []): ModSnapshot {
  return {
    hasHooks: () => true, release() {},
    dispatch: (event, input, core, options) => dispatchModEvent({
      event, input, core, validateResult: options?.validateResult,
      hooks: hook ? [{ plugin: 'test', tier: 'user', registration: { event: 'turn.complete', id: 1, hasCatch: false }, invoke: hook }] : [],
      onFailure: (_plugin, error) => { failures.push(error) },
    }),
  }
}
function observe(turn: ReturnType<typeof createModTurnCompletion>, event: Record<string, unknown>) {
  turn.observe({ type: 'stream_event', event } as StreamEvent)
}

test('partial streamed text is the visible interrupted answer, not thinking or duplicated snapshots', async () => {
  const turn = createModTurnCompletion('turn')
  const first = response('response', 'partial')
  observe(turn, { type: 'message_start', message: { ...first.message, content: [], usage: { ...first.message.usage, output_tokens: 0 } } })
  observe(turn, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private' } })
  observe(turn, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } })
  observe(turn, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
  observe(turn, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'partial' } })
  const { input } = await turn.complete(snapshot(), { ...end, aborted: true })
  expect(input.answer).toBe('partial')
  expect(input.reason).toBe('aborted')
  expect(input.usage).toMatchObject({ input_tokens: 11, output_tokens: 0 })
  turn.observe(first)
  turn.observe({ ...first, uuid: randomUUID() })
  expect((await turn.complete(snapshot(), end)).input.answer).toBe('partial')
})

test('a thinking-only last response clears previous visible text', async () => {
  const turn = createModTurnCompletion('turn')
  turn.observe(response('first', 'earlier answer'))
  const last = response('last', '')
  last.message.content = [{ type: 'thinking', thinking: 'not visible' }]
  last.message.model = 'last-model'
  turn.observe(last)
  const { input } = await turn.complete(snapshot(), end)
  expect(input.answer).toBe('')
  expect(input.usage).toEqual({ model: 'last-model', input_tokens: 22, output_tokens: 6, cache_read_input_tokens: 14, cache_creation_input_tokens: 18 })
})

test('no response means absent usage, even with synthetic errors', async () => {
  const turn = createModTurnCompletion('turn')
  turn.observe({ ...response('synthetic', 'API error'), isApiErrorMessage: true })
  const { input, result } = await turn.complete(snapshot(), end)
  expect(input).toMatchObject({ answer: '', reason: 'error' })
  expect(input).not.toHaveProperty('usage')
  expect(result).toEqual({ text: '' })
})

test('API refusal metadata is preserved, abort/error override refusal', async () => {
  const turn = createModTurnCompletion('turn')
  const message = response('refused', 'declined')
  message.message.stop_reason = 'refusal'
  message.message.stop_details = { category: 'policy', explanation: 'API explanation' }
  turn.observe(message)
  expect((await turn.complete(snapshot(), end)).input.refusal).toEqual(message.message.stop_details)
  for (const [overrides, reason] of [[{ aborted: true }, 'aborted'], [{ failed: true }, 'error']] as const) {
    const { input } = await turn.complete(snapshot(), { ...end, ...overrides })
    expect(input.reason).toBe(reason)
    expect(input).not.toHaveProperty('refusal')
  }
})

test('core uses rewritten input, optional usage may be omitted by a hook', async () => {
  const turn = createModTurnCompletion('turn', 'child')
  turn.observe(response('message', 'answer'))
  const { result } = await turn.complete(snapshot(async (input, next) => {
    const below = await next({ ...input, answer: 'rewritten', agentId: undefined })
    expect(below.text).toBe('rewritten')
    return { text: 'own result' }
  }), end)
  expect(result).toEqual({ text: 'own result' })
})

for (const invalid of [null, [], {}, { text: 3 }, { text: 'bad', usage: {} },
  { text: 'bad', usage: { model: 'x', input_tokens: NaN, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]) {
  test(`malformed hook output is diagnosed and recovers core: ${JSON.stringify(invalid)}`, async () => {
    const turn = createModTurnCompletion('turn')
    turn.observe(response('message', 'answer'))
    const failures: unknown[] = []
    const { result } = await turn.complete(snapshot(async () => invalid, failures), end)
    expect(result.text).toBe('answer')
    expect(failures).toHaveLength(1)
  })
}
