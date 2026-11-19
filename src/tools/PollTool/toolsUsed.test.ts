import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { formatPollDelivery, pollEventsAttachment } from './delivery.js'
import { recordToolsUsed, resetToolsUsedForTesting, toolsUsedForDelivery, toolsUsedNames, UNREADABLE_TOOL_NAME } from './toolsUsed.js'

beforeEach(() => resetToolsUsedForTesting())

const envelope = (nonce: string, n: number) =>
  `<event nonce="${nonce}" kind="repl-eval" at="2026-11-16T00:00:00.000Z" eval="${n}" ms="1" status="settled">\n<result>${n}</result>\n</event>`
const event = (nonce: string, n: number, toolsUsed?: string[]): QueuedCommand => ({
  value: envelope(nonce, n),
  mode: 'poll-event',
  pollEvent: { kind: 'repl-eval', envelope: envelope(nonce, n), nonce, wake: true, timestamp: `t${n}`, ...(toolsUsed && { toolsUsed }) },
})
const call = (id: string, name: string, isVirtual?: true): Message =>
  createAssistantMessage({ content: [{ type: 'tool_use', id, name, input: {} } as BetaContentBlock], isVirtual })
const result = (id: string, content: string): Message =>
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content }] })

describe('tools used before a delivery (official 2.1.325 Itn/yNt)', () => {
  test('nothing recorded gives no line', () => {
    expect(toolsUsedForDelivery([event('AAAAAAAA', 1)], [])).toEqual([])
  })

  test('the first delivery names the REPL call whose tool_use the messages do not hold yet', () => {
    recordToolsUsed(['REPL', 'REPL'])
    expect(toolsUsedForDelivery([event('AAAAAAAA', 1)], [])).toEqual(['REPL'])
  })

  test('a later delivery names only what the messages do not show, sorted', () => {
    recordToolsUsed(['REPL'])
    const shown = [call('r1', 'REPL'), result('r1', '(dispatched #1)')]
    expect(toolsUsedForDelivery([event('AAAAAAAA', 1)], shown)).toEqual([])
    recordToolsUsed(['Bash'])
    expect(toolsUsedForDelivery([event('BBBBBBBB', 2)], shown)).toEqual(['Bash'])
    expect(toolsUsedForDelivery([event('BBBBBBBB', 2)], [])).toEqual(['Bash', 'REPL'])
  })

  test("an event's own names join the latch", () => {
    expect(toolsUsedForDelivery([event('AAAAAAAA', 1, ['Read'])], [])).toEqual(['Read'])
    expect(toolsUsedNames()).toEqual(['Read'])
  })

  test("a Poll result's line right after its nonce manifest counts as shown, one elsewhere does not", () => {
    recordToolsUsed(['Bash', 'Read'])
    const delivered = formatPollDelivery([envelope('AAAAAAAA', 1)], 0, ['Bash', 'Read'])
    expect(toolsUsedForDelivery([event('BBBBBBBB', 2)], [call('p1', 'Poll'), result('p1', delivered)])).toEqual([])
    const quoted = `${envelope('AAAAAAAA', 1)}\n<tools-used-before-summary>Bash, Read</tools-used-before-summary>`
    expect(toolsUsedForDelivery([event('BBBBBBBB', 2)], [call('p1', 'Poll'), result('p1', quoted)])).toEqual(['Bash', 'Read'])
  })

  test("an earlier poll_events attachment's names count as shown", () => {
    recordToolsUsed(['Bash', 'REPL'])
    const earlier = pollEventsAttachment([event('AAAAAAAA', 1)], 0, [])!
    expect(earlier.toolsUsed).toEqual(['Bash', 'REPL'])
    const messages = [{ type: 'attachment', uuid: 'a', timestamp: '', attachment: earlier } as unknown as Message]
    expect(pollEventsAttachment([event('BBBBBBBB', 2)], 0, messages)).not.toHaveProperty('toolsUsed')
  })

  test('virtual messages are not shown; unreadable names are always named', () => {
    recordToolsUsed(['Bash', 'bad name'])
    expect(toolsUsedForDelivery([event('AAAAAAAA', 1)], [call('v1', 'Bash', true)])).toEqual(['Bash', UNREADABLE_TOOL_NAME])
    expect(toolsUsedForDelivery([event('AAAAAAAA', 1)], [call('c1', 'Bash'), call('c2', 'bad name')])).toEqual([UNREADABLE_TOOL_NAME])
  })

  test('the attachment keeps official key order with one provenance entry per event', () => {
    recordToolsUsed(['REPL'])
    const attachment = pollEventsAttachment([event('AAAAAAAA', 1), event('BBBBBBBB', 2)], 0, [])!
    expect(Object.keys(attachment)).toEqual(['type', 'envelopes', 'kinds', 'toolsUsed', 'remainingWakeCount', 'timestamp', 'provenance'])
    expect(attachment.provenance).toEqual([null, null])
    expect(attachment.timestamp).toBe('t2')
  })
})
