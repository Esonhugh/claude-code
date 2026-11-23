import { expect, test } from 'bun:test'
import { createModHookStream } from './dispatch.js'
import { streamModTurnStep } from './turnStepAdapter.js'

const event = (event: Record<string, unknown>) => ({ type: 'stream_event', event }) as never
const start = (id: string) =>
  event({
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: 'm', content: [], usage: {}, stop_reason: null, stop_sequence: null },
  })
const reply = (id: string, block: Record<string, unknown>) =>
  ({
    type: 'assistant',
    uuid: `uuid-${id}`,
    timestamp: '',
    message: { id, type: 'message', role: 'assistant', model: 'm', content: [block], usage: {}, stop_reason: null, stop_sequence: null },
  }) as never

// claude.ts streams a request again when its connection drops before a block
// finished. What the cut request had streamed was never a reply.
test.each([
  [
    'a tool call whose arguments had fully arrived',
    { type: 'tool_use', id: 'toolu_cut', name: 'Bash', input: {} },
    { type: 'input_json_delta', partial_json: '{"command":"rm -rf x"}' },
    { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'rm -rf x' } },
  ],
  [
    'text',
    { type: 'text', text: '' },
    { type: 'text_delta', text: 'PART' },
    { type: 'text', text: 'whole reply' },
  ],
] as const)('a request streamed again after its connection dropped leaves out %s from the cut one', async (_name, cutBlock, cutDelta, block) => {
  const snapshot = {
    stream: (_event: unknown, input: unknown, core: (input: unknown) => AsyncGenerator<unknown, unknown>) =>
      createModHookStream((async function* () {
        return yield* core(input)
      })()),
  } as never
  const replies: unknown[] = []
  for await (const item of streamModTurnStep(snapshot, { turnId: 't', index: 0, model: 'm', messageCount: 1 }, async function* () {
    yield start('msg_cut')
    yield event({ type: 'content_block_start', index: 0, content_block: cutBlock })
    yield event({ type: 'content_block_delta', index: 0, delta: cutDelta })
    yield { type: 'system', subtype: 'api_error' } as never
    yield start('msg_ok')
    yield event({ type: 'content_block_start', index: 0, content_block: { ...block, ...(block.type === 'tool_use' ? { input: {} } : { text: '' }) } })
    yield event({
      type: 'content_block_delta',
      index: 0,
      delta: block.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text },
    })
    yield reply('msg_ok', block)
    yield event({ type: 'content_block_stop', index: 0 })
    yield event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
    yield event({ type: 'message_stop' })
  }, new AbortController().signal)) {
    if ((item as { type: string }).type === 'assistant') replies.push((item as { message: { content: unknown[] } }).message.content[0])
  }
  expect(replies).toEqual([block])
})
