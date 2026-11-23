import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const engine = await import('./QueryEngine.js')
const { resultMessageOf } = engine
const { createAssistantMessage, createUserMessage } = await import('./utils/messages.js')

// --json-schema with a model that never calls StructuredOutput: the turn ends
// on the Stop-hook block cap after meta feedback, and the result was blank.
test('the result skips Stop-hook feedback after the last reply', () => {
  const reply = createAssistantMessage({ content: 'FAKE_DONE' })
  const feedback = createUserMessage({ content: 'Stop hook feedback:\nYou MUST call the StructuredOutput tool', isMeta: true })
  expect(resultMessageOf([createUserMessage({ content: 'give' }), reply, feedback])).toBe(reply)
})

test('a turn ending on tool results still reads the user message', () => {
  const results = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] })
  expect(resultMessageOf([createAssistantMessage({ content: 'x' }), results])).toBe(results)
})

// A ChatGPT response can end with reasoning items after its text. Each item
// is its own message with the same message id; the text is still the result.
test('the result text skips reasoning that follows it in the same response', () => {
  const { resultTextOf } = engine
  const reply = createAssistantMessage({ content: 'FG-OK, waiting' })
  const reasoning = createAssistantMessage({ content: [{ type: 'thinking', thinking: '', signature: '' }] as never })
  reasoning.message.id = reply.message.id
  expect(resultTextOf([createUserMessage({ content: 'go' }), reply, reasoning], reasoning)).toBe('FG-OK, waiting')
  const other = createAssistantMessage({ content: [{ type: 'thinking', thinking: '', signature: '' }] as never })
  expect(resultTextOf([reply, other], other)).toBe('')
})

const { EMPTY_USAGE } = await import('./services/api/emptyUsage.js')
const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event }) as never
const start = (id: string) =>
  streamEvent({ type: 'message_start', message: { id, usage: { input_tokens: 10, output_tokens: 1 } } })
const finish = [
  streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
  streamEvent({ type: 'message_stop' }),
]
const usageOf = (messages: never[]) => {
  let tally = { total: EMPTY_USAGE, current: EMPTY_USAGE, messageId: null as string | null, open: false }
  for (const message of messages) tally = engine.usageAfterMessage(tally, message)
  return [tally.total.input_tokens, tally.total.output_tokens]
}

test('result.usage counts a request whose stream was cut before message_stop', () => {
  expect(usageOf([start('msg_ok'), ...finish])).toEqual([10, 5])
  expect(usageOf([start('msg_cut'), start('msg_ok'), ...finish])).toEqual([20, 6])
})

// Official: the request a turn is interrupted in, or gives up on, is in the
// cost and modelUsage but not in result.usage.
test('result.usage leaves out a cut request that nothing followed', () => {
  expect(usageOf([start('msg_cut')])).toEqual([0, 0])
  expect(usageOf([start('msg_cut'), start('msg_cut_again')])).toEqual([10, 1])
})

// Official: a cut request that was retried counts even when the retry fails
// before it streams anything.
test('result.usage counts a cut request once its retry is announced', () => {
  const retry = { type: 'system', subtype: 'api_error' } as never
  expect(usageOf([start('msg_cut'), retry])).toEqual([10, 1])
  expect(usageOf([start('msg_cut'), retry, start('msg_cut_again'), retry, retry])).toEqual([20, 2])
  expect(usageOf([retry, start('msg_ok'), ...finish, retry])).toEqual([10, 5])
})

// A non-streaming fallback reply has no stream events, only its own usage.
test('result.usage counts a reply that did not stream', () => {
  const reply = createAssistantMessage({ content: 'FAKE_OK' })
  reply.message.id = 'msg_fallback'
  reply.message.model = 'claude-opus-5-5'
  reply.message.usage = { ...reply.message.usage, input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 }
  const streamed = createAssistantMessage({ content: 'partial' })
  streamed.message.id = 'msg_cut'
  streamed.message.usage = { ...streamed.message.usage, input_tokens: 10, output_tokens: 1 }
  expect(usageOf([reply as never, reply as never])).toEqual([1000, 200])
  expect(usageOf([reply as never, createAssistantMessage({ content: 'local' }) as never, reply as never])).toEqual([1000, 200])
  expect(usageOf([start('msg_cut'), streamed as never, reply as never])).toEqual([1010, 201])
})

// Official 2.1.329: result.usage.fallback_credit is the outcome of a
// fallback-credit token the request presented, null when it presented none.
test('result.usage reports fallback_credit as null', () => {
  let tally = { total: EMPTY_USAGE, current: EMPTY_USAGE, messageId: null as string | null, open: false }
  for (const message of [start('msg_ok'), ...finish]) tally = engine.usageAfterMessage(tally, message)
  expect(tally.total.fallback_credit).toBeNull()
  expect(EMPTY_USAGE.fallback_credit).toBeNull()
})
