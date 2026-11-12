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
