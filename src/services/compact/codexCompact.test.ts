import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT,
  buildCodexCompactMetadata,
  buildCodexStyleCompactionResult,
  createCodexStyleCompactionResultFromSummary,
  selectRetainedMessagesForCodexCompact,
  truncateLargeToolResultsForCodexCompact,
} from './codexCompact.js'

function userToolResultMessage(content: string): Message {
  return {
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content,
        },
      ],
    },
    toolUseResult: content,
  } as Message
}

describe('codex compact helpers', () => {
  test('truncates large text tool_result bodies', () => {
    const large = 'x'.repeat(120_000)
    const [message] = truncateLargeToolResultsForCodexCompact([
      userToolResultMessage(large),
    ])

    expect(message?.type).toBe('user')
    if (message?.type !== 'user') return
    const content = message.message.content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    const block = content[0]
    expect(block?.type).toBe('tool_result')
    if (block?.type !== 'tool_result') return
    expect(block.tool_use_id).toBe('toolu_1')
    expect(block.content).toBe(CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT)
  })

  test('does not truncate small tool_result bodies', () => {
    const small = 'small output'
    const [message] = truncateLargeToolResultsForCodexCompact([
      userToolResultMessage(small),
    ])

    expect(message?.type).toBe('user')
    if (message?.type !== 'user') return
    const content = message.message.content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    const block = content[0]
    expect(block?.type).toBe('tool_result')
    if (block?.type !== 'tool_result') return
    expect(block.content).toBe(small)
  })

  test('builds codex compact metadata', () => {
    expect(
      buildCodexCompactMetadata({
        retainedMessageCount: 3,
        retainedApproxTokens: 1234,
        truncatedToolResultCount: 2,
        droppedAttachmentCount: 4,
        retainedUserMessageTokens: 20000,
      }),
    ).toEqual({
      mode: 'codex',
      retainedMessageCount: 3,
      retainedApproxTokens: 1234,
      truncatedToolResultCount: 2,
      droppedAttachmentCount: 4,
      retainedUserMessageTokens: 20000,
    })
  })
})

function userTextMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: text,
    },
  } as Message
}

function assistantToolUseMessage(uuid: string, id: string): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: '/tmp/example.txt' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as Message
}

function matchingToolResultMessage(uuid: string, id: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: 'result',
        },
      ],
    },
  } as Message
}

describe('selectRetainedMessagesForCodexCompact', () => {
  test('keeps recent user messages within approximate budget', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage('00000000-0000-4000-8000-000000000010', 'a'.repeat(1000)),
        userTextMessage('00000000-0000-4000-8000-000000000020', 'recent'),
      ],
      10,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000020',
    ])
    expect(result.approxTokens).toBeGreaterThan(0)
  })

  test('keeps a tool_use with its matching tool_result when retaining the result', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage(
          '00000000-0000-4000-8000-000000000001',
          'old context '.repeat(1000),
        ),
        assistantToolUseMessage(
          '00000000-0000-4000-8000-000000000002',
          'toolu_1',
        ),
        matchingToolResultMessage(
          '00000000-0000-4000-8000-000000000003',
          'toolu_1',
        ),
        userTextMessage('00000000-0000-4000-8000-000000000004', 'continue'),
      ],
      2000,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ])
  })
})

describe('buildCodexStyleCompactionResult', () => {
  test('orders boundary, retained messages, summary, and minimal attachments', () => {
    const boundary = {
      type: 'system',
      uuid: '00000000-0000-4000-8000-0000000000b1',
      timestamp: '2026-06-23T00:00:00.000Z',
      subtype: 'compact_boundary',
      isMeta: true,
      compactMetadata: {},
      content: 'compact boundary',
    } as Message
    const retained = [
      userTextMessage('00000000-0000-4000-8000-0000000000r1', 'recent task'),
    ]
    const summary = [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-0000000000s1',
        timestamp: '2026-06-23T00:00:00.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'summary' },
      } as Message,
    ]
    const hook = {
      type: 'hook_result',
      uuid: '00000000-0000-4000-8000-0000000000h1',
      timestamp: '2026-06-23T00:00:00.000Z',
      content: 'hook',
    } as Message

    const result = buildCodexStyleCompactionResult({
      boundaryMarker: boundary as never,
      summaryMessages: summary as never,
      retainedMessages: retained,
      minimalAttachments: [],
      hookResults: [hook] as never,
      preCompactTokenCount: 1000,
      postCompactTokenCount: 100,
      truePostCompactTokenCount: 100,
      metadata: buildCodexCompactMetadata({
        retainedMessageCount: 1,
        retainedApproxTokens: 3,
        truncatedToolResultCount: 0,
        droppedAttachmentCount: 2,
        retainedUserMessageTokens: 20000,
      }),
    })

    expect(
      [
        result.boundaryMarker,
        ...(result.messagesToKeep ?? []),
        ...result.summaryMessages,
        ...result.attachments,
        ...result.hookResults,
      ].map(message => message.uuid),
    ).toEqual([
      '00000000-0000-4000-8000-0000000000b1',
      '00000000-0000-4000-8000-0000000000r1',
      '00000000-0000-4000-8000-0000000000s1',
      '00000000-0000-4000-8000-0000000000h1',
    ])
    expect(
      (result.boundaryMarker as unknown as {
        compactMetadata: { mode: string }
      }).compactMetadata.mode,
    ).toBe('codex')
  })
})

describe('createCodexStyleCompactionResultFromSummary', () => {
  test('truncates large tool output, retains recent messages, and records metadata', () => {
    const messages = [
      userTextMessage(
        '00000000-0000-4000-8000-000000000099',
        'old context '.repeat(2000),
      ),
      userToolResultMessage('x'.repeat(120_000)),
      userTextMessage(
        '00000000-0000-4000-8000-000000000003',
        'current task',
      ),
    ]
    const boundary = {
      type: 'system',
      uuid: '00000000-0000-4000-8000-0000000000b2',
      timestamp: '2026-06-23T00:00:00.000Z',
      subtype: 'compact_boundary',
      isMeta: true,
      compactMetadata: {},
      content: 'compact boundary',
    } as Message
    const summaryMessages = [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-0000000000s2',
        timestamp: '2026-06-23T00:00:00.000Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'summary' },
      } as Message,
    ]

    const result = createCodexStyleCompactionResultFromSummary({
      originalMessages: messages,
      boundaryMarker: boundary as never,
      summaryMessages: summaryMessages as never,
      hookResults: [],
      options: {
        retainedUserMessageTokens: 20000,
        keepPostCompactAttachments: false,
      },
      preCompactTokenCount: 50000,
      postCompactTokenCount: 1000,
    })

    expect(result.attachments).toEqual([])
    expect(
      (result.boundaryMarker as unknown as { compactMetadata: { mode: string } })
        .compactMetadata.mode,
    ).toBe('codex')
    expect(
      (result.boundaryMarker as unknown as {
        compactMetadata: { truncatedToolResultCount: number }
      }).compactMetadata.truncatedToolResultCount,
    ).toBe(1)
    expect(
      result.messagesToKeep?.some(
        m => m.uuid === '00000000-0000-4000-8000-000000000003',
      ),
    ).toBe(true)
  })
})

describe('codex compact attachment metadata', () => {
  test('records zero dropped attachments when attachment compatibility is enabled', () => {
    const result = createCodexStyleCompactionResultFromSummary({
      originalMessages: [
        userTextMessage(
          '00000000-0000-4000-8000-0000000000a1',
          'current task',
        ),
      ],
      boundaryMarker: {
        type: 'system',
        uuid: '00000000-0000-4000-8000-0000000000b3',
        timestamp: '2026-06-23T00:00:00.000Z',
        subtype: 'compact_boundary',
        isMeta: true,
        compactMetadata: {},
        content: 'compact boundary',
      } as never,
      summaryMessages: [
        {
          type: 'user',
          uuid: '00000000-0000-4000-8000-0000000000s3',
          timestamp: '2026-06-23T00:00:00.000Z',
          isCompactSummary: true,
          message: { role: 'user', content: 'summary' },
        } as never,
      ],
      hookResults: [],
      options: {
        retainedUserMessageTokens: 20000,
        keepPostCompactAttachments: true,
      },
      preCompactTokenCount: 100,
      postCompactTokenCount: 10,
    })

    expect(
      (result.boundaryMarker as unknown as {
        compactMetadata: { droppedAttachmentCount: number }
      }).compactMetadata.droppedAttachmentCount,
    ).toBe(0)
  })
})
