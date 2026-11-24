import { expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import { deserializeMessagesWithInterruptDetection } from './conversationRecovery.js'
import {
  createAssistantMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
  TOOL_CALL_INTERRUPTED_MESSAGE,
} from './messages.js'

function toolUse(id: string, messageId: string) {
  const message = createAssistantMessage({
    content: [
      { type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 55' } },
    ] as never,
  })
  message.message.id = messageId
  return message
}

function toolResult(id: string) {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }],
  })
}

function blocks(messages: Message[]) {
  return messages.flatMap(m =>
    (m.type === 'user' || m.type === 'assistant') &&
    Array.isArray(m.message.content)
      ? m.message.content.filter(
          b => b.type === 'tool_use' || b.type === 'tool_result',
        )
      : [],
  )
}

test('a session killed during a tool call keeps the call and gets an interrupted result (like 2.1.329)', () => {
  const call = toolUse('toolu_cut', 'msg_1')
  const { messages } = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'run it' }),
    call,
  ])

  expect(messages.some(m => m.uuid === call.uuid)).toBe(true)
  const result = messages.find(
    m => m.type === 'user' && m.sourceToolAssistantUUID === call.uuid,
  )
  expect(result?.type === 'user' && result.message.content).toEqual([
    {
      type: 'tool_result',
      content: TOOL_CALL_INTERRUPTED_MESSAGE,
      is_error: true,
      tool_use_id: 'toolu_cut',
    },
  ])
  expect(TOOL_CALL_INTERRUPTED_MESSAGE).toBe(
    "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
  )
  expect(messages.indexOf(result!)).toBe(messages.indexOf(call) + 1)
})

test('only the unanswered calls of the last reply get an interrupted result', () => {
  const { messages } = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'run both' }),
    toolUse('toolu_done', 'msg_1'),
    toolUse('toolu_cut', 'msg_1'),
    toolResult('toolu_done'),
  ])

  expect(
    blocks(messages).map(b => [
      b.type,
      b.type === 'tool_result' ? b.tool_use_id : b.type === 'tool_use' && b.id,
    ]),
  ).toEqual([
    ['tool_use', 'toolu_done'],
    ['tool_use', 'toolu_cut'],
    ['tool_result', 'toolu_done'],
    ['tool_result', 'toolu_cut'],
  ])
})

test('a call answered before a later part of the same reply streamed in keeps only its real result', () => {
  const { messages } = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'run both' }),
    toolUse('toolu_done', 'msg_1'),
    toolResult('toolu_done'),
    toolUse('toolu_cut', 'msg_1'),
  ])

  expect(
    blocks(messages).map(b => [
      b.type,
      b.type === 'tool_result' ? b.tool_use_id : b.type === 'tool_use' && b.id,
      b.type === 'tool_result' && b.content,
    ]),
  ).toEqual([
    ['tool_use', 'toolu_done', false],
    ['tool_result', 'toolu_done', 'done'],
    ['tool_use', 'toolu_cut', false],
    ['tool_result', 'toolu_cut', TOOL_CALL_INTERRUPTED_MESSAGE],
  ])
})

test('an unanswered call the user already moved past is still left out', () => {
  const stale = toolUse('toolu_stale', 'msg_1')
  const { messages } = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'run it' }),
    stale,
    createUserMessage({ content: 'never mind' }),
    createAssistantMessage({ content: 'ok' }),
  ])

  expect(messages.some(m => m.uuid === stale.uuid)).toBe(false)
  expect(blocks(messages)).toEqual([])
})

function texts(messages: Message[]) {
  return messages.flatMap(m =>
    m.type === 'user' || m.type === 'assistant'
      ? typeof m.message.content === 'string'
        ? [`${m.type}: ${m.message.content}`]
        : m.message.content.flatMap(b =>
            b.type === 'text' ? [`${m.type}: ${b.text}`] : [],
          )
      : [],
  )
}

test('the next prompt follows an interrupted call without a synthetic continuation (like official)', () => {
  const previous = process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  try {
    const { messages, turnInterruptionState } =
      deserializeMessagesWithInterruptDetection([
        createUserMessage({ content: 'run it' }),
        toolUse('toolu_cut', 'msg_1'),
      ])

    expect(turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(texts(messages)).toEqual([
      'user: run it',
      `assistant: ${NO_RESPONSE_REQUESTED}`,
    ])
    expect(messages.at(-2)?.type).toBe('user')
  } finally {
    if (previous !== undefined)
      process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = previous
  }
})

test('an auto-resumed interrupted turn still carries the continuation and its sentinel', () => {
  const previous = process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1'
  try {
    const { messages, turnInterruptionState } =
      deserializeMessagesWithInterruptDetection([
        createUserMessage({ content: 'run it' }),
        toolUse('toolu_cut', 'msg_1'),
      ])

    expect(turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(
      turnInterruptionState.kind === 'interrupted_prompt' &&
        messages.indexOf(turnInterruptionState.message),
    ).toBe(messages.length - 2)
    expect(texts(messages).slice(-2)).toEqual([
      'user: Continue from where you left off.',
      `assistant: ${NO_RESPONSE_REQUESTED}`,
    ])
  } finally {
    if (previous === undefined)
      delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
    else process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = previous
  }
})
