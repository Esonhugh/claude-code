import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { resultMessageOf } = await import('./QueryEngine.js')
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
