import { expect, mock, test } from 'bun:test'
import type { AssistantMessage } from '../../types/message.js'

const real = await import('../hooks.js')
const calls: Array<{ turnId: string; messageId: string; index: number; final: boolean; delta: string }> = []
mock.module('../hooks.js', () => ({
  ...real,
  async *executeMessageDisplayHooks(display: (typeof calls)[number]) {
    calls.push(display)
    yield { displayContent: `<${display.delta}>` }
  },
}))
const { applyCompletedMessageDisplayHooks } = await import('./messageDisplay.js')

const assistant = (content: AssistantMessage['message']['content']) =>
  ({ type: 'assistant', uuid: 'u1', message: { id: 'm1', content } }) as unknown as AssistantMessage

// Official 2.1.311 headless path: one final flush per completed message, texts joined,
// the first text block carries the display text and later text blocks are emptied.
test('completed message display rewrites only the emitted copy', async () => {
  calls.length = 0
  const original = assistant([
    { type: 'text', text: 'a' },
    { type: 'tool_use', id: 't', name: 'Bash', input: {} },
    { type: 'text', text: 'b' },
  ] as AssistantMessage['message']['content'])
  const shown = await applyCompletedMessageDisplayHooks(original, 'turn-1')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ turnId: 'turn-1', index: 0, final: true, delta: 'ab' })
  expect(calls[0]!.messageId).not.toBe('u1')
  expect(shown.message.content).toMatchObject([{ text: '<ab>' }, { type: 'tool_use' }, { text: '' }])
  expect(original.message.content[0]).toMatchObject({ text: 'a' })
})

test('messages without text skip the hook', async () => {
  calls.length = 0
  const original = assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] as AssistantMessage['message']['content'])
  expect(await applyCompletedMessageDisplayHooks(original, 'turn-1')).toBe(original)
  expect(calls).toHaveLength(0)
})
