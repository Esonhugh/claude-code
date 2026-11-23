import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const claude = await import('./claude.js')
const { streamEventThinkingDisplay } = claude

const event = (value: Record<string, unknown>) => value as never

// Official 2.1.329: stream_event.thinking_display is set on message_start, on a
// thinking block's content_block_start and on thinking_delta, when the request
// body had a display.
test('the request display rides on the events of a thinking block only', () => {
  const carried = [
    event({ type: 'message_start', message: { id: 'msg_1' } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }),
  ]
  for (const part of carried) expect(streamEventThinkingDisplay(part, 'summarized')).toBe('summarized')

  const bare = [
    event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }),
    event({ type: 'content_block_stop', index: 0 }),
    event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }),
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
    event({ type: 'message_stop' }),
  ]
  for (const part of bare) expect(streamEventThinkingDisplay(part, 'summarized')).toBeUndefined()
})

test('no display in the request body leaves every event without one', () => {
  expect(streamEventThinkingDisplay(event({ type: 'message_start', message: { id: 'msg_1' } }), undefined)).toBeUndefined()
})

test('the assistant message keeps the display for a thinking block only', () => {
  const { blockThinkingDisplay } = claude
  expect(blockThinkingDisplay({ type: 'thinking' }, 'summarized')).toBe('summarized')
  expect(blockThinkingDisplay({ type: 'redacted_thinking' }, 'summarized')).toBeUndefined()
  expect(blockThinkingDisplay({ type: 'text' }, 'summarized')).toBeUndefined()
  expect(blockThinkingDisplay({ type: 'thinking' }, undefined)).toBeUndefined()
})
