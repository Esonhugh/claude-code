import { expect, test } from 'bun:test'

import type { AssistantMessage, Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import {
  keepMoreRoundsAfterPTL,
  roundsForRecentBudget,
  splitKeptTail,
} from './compact.js'

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

function rounds(n: number): Message[] {
  const out: Message[] = [createUserMessage({ content: 'start' })]
  for (let i = 0; i < n; i++) {
    out.push(reply(`round ${i} ${'x'.repeat(400)}`))
    out.push(createUserMessage({ content: `next ${i}` }))
  }
  return out
}

test('keptRounds 0 summarizes everything; 2 keeps the last two rounds (2.1.319)', () => {
  const msgs = rounds(4)
  expect(splitKeptTail(msgs, 0)).toEqual({ toSummarize: msgs, toKeep: [] })
  const { toSummarize, toKeep } = splitKeptTail(msgs, 2)
  expect(toSummarize).toEqual(msgs.slice(0, 5))
  expect(toKeep.map(m => m.uuid)).toEqual(msgs.slice(5).map(m => m.uuid))
})

test('a too-long summary request keeps more rounds instead of dropping old ones (2.1.319)', () => {
  const msgs = rounds(6)
  // Unknown gap: a fifth of the summarized rounds, at least one.
  expect(keepMoreRoundsAfterPTL(msgs, 1, undefined)?.keptRounds).toBe(2)
  // A gap of about two rounds keeps two more.
  const wider = keepMoreRoundsAfterPTL(msgs, 1, 150)
  expect(wider?.keptRounds).toBe(3)
  expect(wider?.toSummarize).toEqual(msgs.slice(0, 7))
  // Nothing left to summarize once only the first round remains.
  expect(keepMoreRoundsAfterPTL(msgs, 5, undefined)).toBeNull()
})

test('keep-recent budget keeps the trailing rounds that reach the budget', () => {
  const msgs = rounds(10)
  expect(roundsForRecentBudget(msgs, 0)).toBe(1)
  const two = roundsForRecentBudget(msgs, 150)
  expect(two).toBeGreaterThan(1)
  expect(two).toBeLessThan(10)
  expect(roundsForRecentBudget(msgs, 1_000_000)).toBe(11)
})

