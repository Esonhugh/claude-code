import { describe, expect, test } from 'bun:test'
import { createRemoteShellTranscript } from '../../ssh/remoteShellTranscript.js'
import { processTextPrompt } from '../../utils/processUserInput/processTextPrompt.js'
import type { Message, UserMessage } from '../../types/message.js'
import { normalizeMessagesForAPI } from '../../utils/messages.js'
import { buildPostCompactMessages } from './compact.js'
import {
  buildCodexCompactMetadata,
  buildCodexStyleCompactionResult,
  createCodexStyleCompactionResultFromSummary,
  selectRetainedMessagesForCodexCompact,
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
  test('builds codex compact metadata', () => {
    expect(
      buildCodexCompactMetadata({
        retainedMessageCount: 3,
        retainedApproxTokens: 1234,
        droppedAttachmentCount: 4,
        retainedUserMessageTokens: 20000,
      }),
    ).toEqual({
      mode: 'codex',
      retainedMessageCount: 3,
      retainedApproxTokens: 1234,
      droppedAttachmentCount: 4,
      retainedUserMessageTokens: 20000,
    })
  })
})

function userTextMessage(uuid: string, text: string): UserMessage {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: text,
    },
  } as UserMessage
}

function assistantWriteMessage(uuid: string, id: string, content: string): Message {
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
          name: 'Write',
          input: { file_path: '/tmp/example.txt', content },
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
      1000,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020',
    ])
    expect(result.approxTokens).toBeGreaterThan(0)
  })

  test('truncates the user message that overflows the budget and stops', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage('00000000-0000-4000-8000-000000000005', 'oldest'),
        userTextMessage('00000000-0000-4000-8000-000000000010', 'a'.repeat(1000)),
        userTextMessage('00000000-0000-4000-8000-000000000020', 'recent'),
      ],
      10,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020',
    ])
    const truncated = result.messages[0]
    if (truncated?.type !== 'user') throw new Error('expected user message')
    expect(truncated.message.content).toBe('a'.repeat(32))
    expect(result.approxTokens).toBe(10)
  })

  test('drops assistant turns and tool calls, so large Write inputs are not retained', () => {
    const messages: Message[] = [
      userTextMessage('00000000-0000-4000-8000-000000000001', 'write the files'),
    ]
    for (let i = 0; i < 30; i++) {
      messages.push(
        assistantWriteMessage(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, `toolu_${i}`, 'x'.repeat(40_000)),
        matchingToolResultMessage(`00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`, `toolu_${i}`),
      )
    }
    messages.push(userTextMessage('00000000-0000-4000-8000-000000000003', 'continue'))

    const result = selectRetainedMessagesForCodexCompact(messages, 20_000)

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
    ])
  })

  test('skips summaries, meta messages, and tool results', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        { ...userTextMessage('00000000-0000-4000-8000-000000000001', 'old summary'), isCompactSummary: true } as Message,
        { ...userTextMessage('00000000-0000-4000-8000-000000000002', 'injected'), isMeta: true } as Message,
        userToolResultMessage('tool output'),
        userTextMessage('00000000-0000-4000-8000-000000000004', 'real prompt'),
      ],
      20_000,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000004',
    ])
  })

  test('keeps only the text of a user message with images', () => {
    const withImage = {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: '2026-06-23T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'look at this' },
        ],
      },
    } as Message

    const [message] = selectRetainedMessagesForCodexCompact([withImage], 20_000).messages

    if (message?.type !== 'user') throw new Error('expected user message')
    expect(message.message.content).toBe('look at this')
  })

  test('keeps terminal-looking user text but skips actual shell rows', () => {
    const output = createRemoteShellTranscript('printf hello', {
      stdout: 'hello',
      stderr: '',
      code: 0,
      interrupted: false,
    })
    const prompts = [
      '<bash-stdout>hello</bash-stdout> What does this mean?',
      '<bash-stdout>hello</bash-stdout><bash-stderr></bash-stderr>',
    ].flatMap(text => processTextPrompt(text, [], [], []).messages)

    const roundTrip = (messages: Message[]): Message[] =>
      JSON.parse(JSON.stringify(messages))
    expect(
      selectRetainedMessagesForCodexCompact(roundTrip([...prompts, ...output]), 1000)
        .messages,
    ).toEqual(roundTrip(prompts))
  })

  test('keeps a legacy prompt with prose after the terminal envelope', () => {
    const prompt = userTextMessage(
      '00000000-0000-4000-8000-000000000007',
      '<bash-stdout>example</bash-stdout> What does this mean?',
    )
    expect(selectRetainedMessagesForCodexCompact([prompt], 1000).messages)
      .toEqual([prompt])
  })

  test('keeps a legacy prompt between two terminal envelopes', () => {
    const prompts = [
      '<bash-stdout>a</bash-stdout> compare with <bash-stdout>b</bash-stdout>',
      '<bash-input>ls</bash-input> vs <bash-input>pwd</bash-input>',
      '<local-command-stdout>a</local-command-stdout> why changed to <local-command-stdout>b</local-command-stdout>',
      '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr> and <bash-stdout>b</bash-stdout><bash-stderr></bash-stderr>',
    ].map((text, i) => userTextMessage(`00000000-0000-4000-8000-00000000001${i}`, text))
    expect(selectRetainedMessagesForCodexCompact(prompts, 1000).messages)
      .toEqual(prompts)
  })

  test('skips user text that is only whitespace', () => {
    const blank = {
      ...userTextMessage('00000000-0000-4000-8000-000000000020', ''),
      message: { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: ' ' }] },
    } as UserMessage
    expect(selectRetainedMessagesForCodexCompact([blank], 1000)).toEqual({ messages: [], approxTokens: 0 })
  })

  test('charges one token per one-character reply', () => {
    const replies = ['a', 'b', 'c'].map((text, i) =>
      userTextMessage(`00000000-0000-4000-8000-00000000000${i}`, text),
    )

    expect(selectRetainedMessagesForCodexCompact(replies, 1)).toEqual({
      messages: [replies[2]!],
      approxTokens: 1,
    })
  })

  test('skips legacy local command rows and their output', () => {
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage('00000000-0000-4000-8000-000000000001', 'real prompt'),
        {
          ...userTextMessage('00000000-0000-4000-8000-000000000002', '<bash-input>cat big.log</bash-input>'),
          origin: { kind: 'human' },
        },
        userTextMessage('00000000-0000-4000-8000-000000000003', `<bash-stdout>${'x'.repeat(40_000)}</bash-stdout><bash-stderr></bash-stderr>`),
        userTextMessage('00000000-0000-4000-8000-000000000004', '<local-command-caveat>Caveat: ...</local-command-caveat>'),
        userTextMessage('00000000-0000-4000-8000-000000000005', '<local-command-stdout>Set model to opus</local-command-stdout>'),
      ],
      20_000,
    )

    expect(result.messages.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ])
  })

  test('does not split an emoji when truncating', () => {
    // 'abc' + U+1F600: the 4-char cut lands between the surrogate halves.
    const result = selectRetainedMessagesForCodexCompact(
      [userTextMessage('00000000-0000-4000-8000-000000000001', `abc\u{1F600}${'d'.repeat(100)}`)],
      1,
    )

    const [message] = result.messages
    if (message?.type !== 'user') throw new Error('expected user message')
    expect(message.message.content).toBe('abc')
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
        compactMetadata: {
          mode: string
          provider: string
          preCompactTokens: number
          postCompactTokens: number
          compactionCallTokens: number
        }
      }).compactMetadata,
    ).toMatchObject({
      mode: 'codex',
      provider: 'openai',
      preCompactTokens: 1000,
      postCompactTokens: 100,
      compactionCallTokens: 100,
    })
  })
})

describe('createCodexStyleCompactionResultFromSummary', () => {
  test('retains recent user messages without tool output and records metadata', () => {
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
      attachments: [],
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
    expect(result.messagesToKeep?.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000099',
      '00000000-0000-4000-8000-000000000003',
    ])
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
      attachments: [],
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

describe('codex compact post-compact attachments', () => {
  const attachment = {
    type: 'attachment',
    uuid: '00000000-0000-4000-8000-0000000000c1',
    timestamp: '2026-06-23T00:00:00.000Z',
    attachment: { type: 'plan_mode', planFilePath: '/tmp/plan.md' },
  } as never
  const run = (keepPostCompactAttachments: boolean) =>
    createCodexStyleCompactionResultFromSummary({
      originalMessages: [
        userTextMessage('00000000-0000-4000-8000-0000000000a2', 'current task'),
      ],
      boundaryMarker: {
        type: 'system',
        uuid: '00000000-0000-4000-8000-0000000000b4',
        timestamp: '2026-06-23T00:00:00.000Z',
        subtype: 'compact_boundary',
        isMeta: true,
        compactMetadata: {},
        content: 'compact boundary',
      } as never,
      summaryMessages: [],
      attachments: [attachment],
      hookResults: [],
      options: { retainedUserMessageTokens: 20000, keepPostCompactAttachments },
    })
  const dropped = (result: ReturnType<typeof run>) =>
    (result.boundaryMarker as unknown as {
      compactMetadata: { droppedAttachmentCount: number }
    }).compactMetadata.droppedAttachmentCount

  test('keeps the rehydrated attachments when keepPostCompactAttachments is true', () => {
    const result = run(true)
    expect(result.attachments).toEqual([attachment])
    expect(dropped(result)).toBe(0)
  })

  test('drops and counts them by default', () => {
    const result = run(false)
    expect(result.attachments).toEqual([])
    expect(dropped(result)).toBe(1)
  })
})

describe('codex compact keeps loaded deferred tools', () => {
  const toolSearchResult = {
    type: 'user',
    uuid: '00000000-0000-4000-8000-0000000000d1',
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_ts',
          content: [{ type: 'tool_reference', tool_name: 'WebFetch' }],
        },
      ],
    },
  } as unknown as Message
  const deferredList = {
    type: 'attachment',
    uuid: '00000000-0000-4000-8000-0000000000d2',
    timestamp: '2026-06-23T00:00:00.000Z',
    attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch'], addedLines: ['WebFetch'], removedNames: [] },
  } as never
  const result = createCodexStyleCompactionResultFromSummary({
    originalMessages: [
      toolSearchResult,
      userTextMessage('00000000-0000-4000-8000-0000000000d3', 'current task'),
    ],
    boundaryMarker: {
      type: 'system',
      uuid: '00000000-0000-4000-8000-0000000000d4',
      timestamp: '2026-06-23T00:00:00.000Z',
      subtype: 'compact_boundary',
      isMeta: true,
      compactMetadata: {},
      content: 'compact boundary',
    } as never,
    summaryMessages: [],
    attachments: [deferredList],
    hookResults: [],
    options: { retainedUserMessageTokens: 1, keepPostCompactAttachments: false },
  })

  test('carries tools discovered before compaction on the new boundary', () => {
    expect(
      (result.boundaryMarker as unknown as {
        compactMetadata: { preCompactDiscoveredTools?: string[] }
      }).compactMetadata.preCompactDiscoveredTools,
    ).toEqual(['WebFetch'])
  })

  test('keeps the deferred tool list when other attachments are dropped', () => {
    expect(result.attachments).toEqual([deferredList])
  })
})

describe('codex compact retention edges', () => {
  test('skips transcript-only rows and image-only messages without spending budget', () => {
    const imageOnly = {
      type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000e2',
      timestamp: '2026-06-23T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      },
    } as Message
    const result = selectRetainedMessagesForCodexCompact(
      [
        userTextMessage('00000000-0000-4000-8000-0000000000e1', 'abcdefgh'),
        imageOnly,
        { ...userTextMessage('00000000-0000-4000-8000-0000000000e3', 'shown only'), isVisibleInTranscriptOnly: true } as Message,
      ],
      2,
    )

    expect(result.messages.map(m => m.uuid)).toEqual(['00000000-0000-4000-8000-0000000000e1'])
    expect(result.approxTokens).toBe(2)
  })

  test('retains nothing when the budget is zero', () => {
    expect(
      selectRetainedMessagesForCodexCompact(
        [userTextMessage('00000000-0000-4000-8000-0000000000e4', 'hello')],
        0,
      ),
    ).toEqual({ messages: [], approxTokens: 0 })
  })
})

function writeSession(writes: number): Message[] {
  const messages: Message[] = [
    userTextMessage('00000000-0000-4000-8000-000000000f01', 'write the files'),
  ]
  for (let i = 0; i < writes; i++) {
    const n = String(i).padStart(2, '0')
    messages.push(
      assistantWriteMessage(`00000000-0000-4000-8000-000000000a${n}`, `toolu_w${n}`, 'x'.repeat(40_000)),
      matchingToolResultMessage(`00000000-0000-4000-8000-000000000b${n}`, `toolu_w${n}`),
    )
  }
  messages.push(userTextMessage('00000000-0000-4000-8000-000000000f02', 'now add tests'))
  return messages
}

const codexBoundary = (uuid: string) =>
  ({
    type: 'system',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    subtype: 'compact_boundary',
    isMeta: true,
    compactMetadata: {},
    content: 'compact boundary',
  }) as never

const codexSummary = (uuid: string, text: string) =>
  ({
    type: 'user',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: text },
  }) as Message

const compactWrites = (originalMessages: Message[], summaryUuid: string) =>
  createCodexStyleCompactionResultFromSummary({
    originalMessages,
    boundaryMarker: codexBoundary('00000000-0000-4000-8000-000000000c01'),
    summaryMessages: [codexSummary(summaryUuid, `summary ${summaryUuid}`)] as never,
    attachments: [],
    hookResults: [],
    options: { retainedUserMessageTokens: 20_000, keepPostCompactAttachments: false },
    preCompactTokenCount: 300_000,
    postCompactTokenCount: 500,
  })

describe('codex compaction of a Write-heavy session', () => {
  test('records metadata that matches what was retained', () => {
    const result = compactWrites(writeSession(30), '00000000-0000-4000-8000-000000000d01')
    const metadata = (result.boundaryMarker as unknown as {
      compactMetadata: { retainedMessageCount: number; retainedApproxTokens: number; postCompactTokens: number }
    }).compactMetadata

    expect(result.messagesToKeep?.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000f01',
      '00000000-0000-4000-8000-000000000f02',
    ])
    expect(metadata.retainedMessageCount).toBe(2)
    expect(metadata.retainedApproxTokens).toBe(7)
    expect(result.truePostCompactTokenCount).toBe(507)
    expect(metadata.postCompactTokens).toBe(507)
  })

  test('a second compaction drops the first summary and keeps the user messages', () => {
    const first = compactWrites(writeSession(30), '00000000-0000-4000-8000-000000000d01')
    const second = compactWrites(
      [
        first.boundaryMarker,
        ...first.summaryMessages,
        ...(first.messagesToKeep ?? []),
        ...writeSession(5).slice(1, -1),
        userTextMessage('00000000-0000-4000-8000-000000000f03', 'one more thing'),
      ],
      '00000000-0000-4000-8000-000000000d02',
    )

    expect(second.messagesToKeep?.map(m => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000f01',
      '00000000-0000-4000-8000-000000000f02',
      '00000000-0000-4000-8000-000000000f03',
    ])
  })

  test('the next request is a valid conversation with no tool blocks or file contents', () => {
    const result = compactWrites(writeSession(30), '00000000-0000-4000-8000-000000000d01')
    const api = normalizeMessagesForAPI([
      ...buildPostCompactMessages(result),
      userTextMessage('00000000-0000-4000-8000-000000000f09', 'continue'),
    ])
    const blocks = api.flatMap(m =>
      typeof m.message.content === 'string' ? [] : m.message.content,
    )

    expect(api[0]?.type).toBe('user')
    expect(api.every((m, i) => i === 0 || m.type !== api[i - 1]!.type)).toBe(true)
    expect(blocks.some(b => b.type === 'tool_use' || b.type === 'tool_result')).toBe(false)
    expect(blocks.some(b => b.type === 'text' && !b.text)).toBe(false)
    expect(JSON.stringify(api)).not.toContain('x'.repeat(100))
    expect(JSON.stringify(api)).toContain('now add tests')
  })
})
