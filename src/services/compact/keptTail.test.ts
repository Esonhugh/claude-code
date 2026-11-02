import { expect, test } from 'bun:test'

import type { AssistantMessage, Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { splitKeptTail } from './compact.js'

function reply(text: string): AssistantMessage {
  const m = createAssistantMessage({ content: text })
  m.message.usage = { ...m.message.usage, input_tokens: 900, output_tokens: 40 }
  return m
}

test('full compact keeps the last API round verbatim with zeroed usage (2.1.311)', () => {
  const p1 = createUserMessage({ content: 'remember pineapple' })
  const a1 = reply('OK')
  const p2 = createUserMessage({ content: 'what is the word?' })
  const a2 = reply('pineapple')
  const { toSummarize, toKeep } = splitKeptTail([p1, a1, p2, a2])
  expect(toSummarize).toEqual([p1, a1, p2])
  expect(toKeep.map(m => m.uuid)).toEqual([a2.uuid])
  const kept = toKeep[0] as AssistantMessage
  expect(kept.message.usage.input_tokens).toBe(0)
  expect(kept.message.usage.output_tokens).toBe(0)
  expect(a2.message.usage.input_tokens).toBe(900)
})

test('nothing is kept when the rest has no assistant reply to summarize', () => {
  const p1 = createUserMessage({ content: 'hello' })
  const a1 = reply('hi')
  expect(splitKeptTail([p1, a1])).toEqual({ toSummarize: [p1, a1], toKeep: [] })
  const only: Message[] = [p1]
  expect(splitKeptTail(only)).toEqual({ toSummarize: only, toKeep: [] })
})
