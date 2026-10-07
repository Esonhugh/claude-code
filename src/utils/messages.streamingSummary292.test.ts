import { expect, test } from 'bun:test'
import type { Message, StreamEvent } from '../types/message.js'
import {
  createAssistantMessage,
  handleMessageFromStream,
  type StreamingThinking,
} from './messages.js'

const signature = Buffer.from([18, 13, 10, 11, 66, 9, ...new TextEncoder().encode('narration')]).toString('base64')
const thinkingBlock = (thinking: string, signed = signature) => ({ type: 'thinking' as const, thinking, signature: signed })

function consumer(initial: StreamingThinking | null = null) {
  const state = {
    thinking: initial,
    text: 'old streaming text' as string | null,
    saved: [] as Message[],
    atLanding: [] as (StreamingThinking | null)[],
    updates: [] as (StreamingThinking | null)[],
    lengths: [] as string[],
    sequence: [] as string[],
  }
  function accept(message: Parameters<typeof handleMessageFromStream>[0]) {
    handleMessageFromStream(message, row => {
      state.sequence.push('message')
      state.atLanding.push(state.thinking)
      state.saved.push(row)
    }, text => state.lengths.push(text), () => {}, () => {}, undefined,
    update => {
      state.thinking = update(state.thinking)
      state.updates.push(state.thinking)
      state.sequence.push('thinking')
    }, undefined, update => {
      state.text = update(state.text)
      state.sequence.push('text')
    })
  }
  return { state, accept }
}

function stream(event: StreamEvent['event']): StreamEvent { return { type: 'stream_event', event } }

// Official 2.1.292 qJe clears the private preview when eyt classifies a landed narration.
test.each([null, { thinking: 'MODS_LIVE_DISPLAY', isStreaming: true },
  { thinking: 'OLDER_PRIVATE_PREVIEW', isStreaming: false, streamingEndedAt: 1 }])(
  'landed narration clears its preview before the exact original message is saved (%j)', initial => {
    const h = consumer(initial)
    const row = createAssistantMessage({ content: [thinkingBlock('SIGNED_ORIGINAL')] })
    const original = JSON.stringify(row)
    h.accept(row)
    expect(h.state.thinking).toBeNull()
    expect(h.state.atLanding).toEqual([null])
    expect(h.state.sequence).toEqual(['thinking', 'text', 'message'])
    expect(h.state.text).toBeNull()
    expect(h.state.saved[0]).toBe(row)
    expect(JSON.stringify(row)).toBe(original)
  },
)

test('stream completion and later text cannot recreate the cleared narration preview', () => {
  const h = consumer()
  h.accept(stream({ type: 'content_block_start', index: 0, content_block: thinkingBlock('', '') }))
  h.accept(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'LIVE_DISPLAY' } }))
  h.accept(stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } }))
  h.accept(createAssistantMessage({ content: [thinkingBlock('SIGNED_ORIGINAL')] }))
  h.accept(stream({ type: 'content_block_stop', index: 0 }))
  h.accept(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
  h.accept(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ANSWER' } }))
  h.accept(createAssistantMessage({ content: 'ANSWER' }))
  h.accept(stream({ type: 'message_stop' }))
  expect(h.state.thinking).toBeNull()
  expect(h.state.atLanding).toEqual([null, null])
  const first = h.state.saved[0], second = h.state.saved[1]
  if (first?.type !== 'assistant' || second?.type !== 'assistant') throw new Error('Expected thinking and text assistant rows')
  expect(first.message.content).toEqual([thinkingBlock('SIGNED_ORIGINAL')])
  expect(second.message.content).toEqual([{ type: 'text', text: 'ANSWER' }])
  expect(h.state.lengths).toEqual(['LIVE_DISPLAY', 'ANSWER'])
})

test.each(['', 'not a signature', Buffer.concat([Buffer.from(signature, 'base64'), Buffer.from([128])]).toString('base64')])(
  'private or malformed thinking retains the signed original and short-lived preview (%s)', signed => {
    const h = consumer()
    const row = createAssistantMessage({ content: [thinkingBlock('PRIVATE_BODY', signed)] })
    const before = Date.now()
    h.accept(row)
    expect(h.state.thinking).toMatchObject({ thinking: 'PRIVATE_BODY', isStreaming: false })
    expect(h.state.thinking!.streamingEndedAt).toBeGreaterThanOrEqual(before)
    expect(h.state.thinking!.streamingEndedAt).toBeLessThanOrEqual(Date.now())
    expect(h.state.saved[0]).toBe(row)
  },
)

test('an ordinary private block keeps the existing Mods live display without rewriting the signed block', () => {
  const h = consumer({ thinking: 'MODS_PRIVATE_DISPLAY', isStreaming: true })
  const row = createAssistantMessage({ content: [thinkingBlock('PRIVATE_SIGNED_ORIGINAL', 'private signature')] })
  h.accept(row)
  expect(h.state.thinking).toMatchObject({ thinking: 'MODS_PRIVATE_DISPLAY', isStreaming: false })
  expect(row.message.content).toEqual([thinkingBlock('PRIVATE_SIGNED_ORIGINAL', 'private signature')])
})

test('whitespace narration is not classified as a summary and uses the ordinary preview path', () => {
  const h = consumer()
  h.accept(createAssistantMessage({ content: [thinkingBlock('  \n  ')] }))
  expect(h.state.thinking).toMatchObject({ thinking: '  \n  ', isStreaming: false })
})

test('the first thinking block determines the handoff, matching the native message consumer', () => {
  const h = consumer()
  const row = createAssistantMessage({ content: [thinkingBlock('PRIVATE_FIRST', 'private signature'), thinkingBlock('SUMMARY_SECOND')] })
  h.accept(row)
  expect(h.state.thinking).toMatchObject({ thinking: 'PRIVATE_FIRST', isStreaming: false })
  const reversed = createAssistantMessage({ content: [thinkingBlock('SUMMARY_FIRST'), thinkingBlock('PRIVATE_SECOND', 'private signature')] })
  h.accept(reversed)
  expect(h.state.thinking).toBeNull()
  expect(h.state.saved).toEqual([row, reversed])
})

test('a text-only reply preserves a previous ordinary private preview', () => {
  const preview = { thinking: 'PREVIOUS_PRIVATE', isStreaming: false, streamingEndedAt: 123 }
  const h = consumer(preview)
  h.accept(createAssistantMessage({ content: 'ANSWER' }))
  expect(h.state.thinking).toBe(preview)
  expect(h.state.updates).toEqual([])
})

test('classification happens at the signed message boundary, not a raw signature delta', () => {
  const h = consumer({ thinking: 'UNFINISHED_DISPLAY', isStreaming: true })
  h.accept(stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } }))
  expect(h.state.thinking).toMatchObject({ thinking: 'UNFINISHED_DISPLAY', isStreaming: true })
  expect(h.state.updates).toEqual([])
  h.accept(createAssistantMessage({ content: [thinkingBlock('LANDED_SUMMARY')] }))
  expect(h.state.thinking).toBeNull()
  expect(h.state.lengths).toEqual([])
})
