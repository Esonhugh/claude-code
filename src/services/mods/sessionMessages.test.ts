import { expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import {
  projectModApiMessages,
  projectModSessionMessages,
} from './sessionMessages.js'

test('projects joined text and structured tool outcomes without mutating the transcript', () => {
  const call = createAssistantMessage({
    content: [
      { type: 'text', text: 'before', citations: [] },
      { type: 'tool_use', id: 'ok', name: 'Read', input: { file_path: 'a' } },
      { type: 'tool_use', id: 'failed', name: 'Write', input: {} },
      {
        type: 'tool_use',
        id: 'pending',
        name: 'Bash',
        input: { command: 'true' },
      },
      { type: 'text', text: 'after', citations: [] },
    ],
  })
  const result = { kind: 'text', content: 'structured' }
  const messages = [
    call,
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'ok',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
      toolUseResult: result,
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'failed',
          content: 'denied',
          is_error: true,
        },
      ],
      toolUseResult: 'denied',
    }),
  ]
  const before = structuredClone(messages)
  expect(projectModSessionMessages(messages)).toEqual([
    {
      role: 'assistant',
      text: 'beforeafter',
      toolUses: [
        {
          tool_use_id: 'ok',
          tool: 'Read',
          input: { file_path: 'a' },
          result,
          text: 'ab',
        },
        {
          tool_use_id: 'failed',
          tool: 'Write',
          input: {},
          result: 'denied',
          text: 'denied',
          isError: true,
        },
        { tool_use_id: 'pending', tool: 'Bash', input: { command: 'true' } },
      ],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'ok', text: 'ab', isError: false, result }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [
        {
          tool_use_id: 'failed',
          text: 'denied',
          isError: true,
          result: 'denied',
        },
      ],
    },
  ])
  expect(messages).toEqual(before)
})

test('filters non-conversation and meta user messages and retains only the newest 4096', () => {
  const messages = Array.from({ length: 4100 }, (_, i) =>
    createUserMessage({ content: String(i) }),
  )
  messages.push(createUserMessage({ content: 'meta', isMeta: true }))
  messages.push({
    ...createUserMessage({ content: 'virtual' }),
    isVirtual: true,
  })
  const result = projectModSessionMessages([
    ...messages,
    { type: 'progress' } as any,
  ])
  expect(result).toHaveLength(4096)
  expect(result[0]).toEqual({ role: 'user', text: '4', toolUses: [] })
  expect(result.at(-1)?.text).toBe('4099')
})

test('a tool without a stored record keeps result absent rather than inventing one', () => {
  const messages = [
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }],
    }),
  ]
  const result = projectModSessionMessages(messages)
  expect(result[0]?.toolUses[0]).toEqual({
    tool_use_id: 'x',
    tool: 'Bash',
    input: {},
    text: 'output',
  })
  expect(result[1]?.toolResults?.[0]).toEqual({
    tool_use_id: 'x',
    text: 'output',
    isError: false,
  })
})

test('Agent summaries derive identity and duration only from the real stored completion', () => {
  const messages = [
    createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'agent',
          name: 'Agent',
          input: { agentId: 'prompt-is-not-identity' },
        },
      ],
    }),
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'done' }],
      toolUseResult: {
        status: 'completed',
        agentId: 'real-child',
        totalDurationMs: 123,
      },
    }),
  ]
  expect(projectModSessionMessages(messages)[0]?.toolUses[0]).toMatchObject({
    agentId: 'real-child',
    durationMs: 123,
  })
})

test('tracked pending Agent identity is available without invented duration', () => {
  const messages = [
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'pending', name: 'Agent', input: {} }],
    }),
  ]
  expect(
    projectModSessionMessages(
      messages,
      4096,
      new Map([['pending', 'running-child']]),
    )[0]?.toolUses[0],
  ).toEqual({
    tool_use_id: 'pending',
    tool: 'Agent',
    input: {},
    agentId: 'running-child',
  })
})

test('background, refused and non-Agent results never acquire completion duration', () => {
  for (const [tool, record, error] of [
    [
      'Agent',
      { status: 'async_launched', agentId: 'background', totalDurationMs: 999 },
      false,
    ],
    [
      'Agent',
      { status: 'completed', agentId: 'refused', totalDurationMs: 999 },
      true,
    ],
    [
      'Read',
      { status: 'completed', agentId: 'unrelated', totalDurationMs: 999 },
      false,
    ],
  ] as const) {
    const messages = [
      createAssistantMessage({
        content: [{ type: 'tool_use', id: 'call', name: tool, input: {} }],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call',
            content: 'output',
            is_error: error,
          },
        ],
        toolUseResult: record,
      }),
    ]
    const summary = projectModSessionMessages(messages)[0]?.toolUses[0]
    expect(summary).not.toHaveProperty('durationMs')
    if (tool !== 'Agent' || error) expect(summary).not.toHaveProperty('agentId')
    else expect(summary).toHaveProperty('agentId', 'background')
  }
})

test('API projection uses the last compact summary and normalized reminders without exposing UI rows', () => {
  const messages = [
    createUserMessage({ content: 'OLD_PRIVATE_CONTEXT' }),
    createAssistantMessage({ content: 'old answer' }),
    createCompactBoundaryMessage('manual', 100),
    createUserMessage({ content: 'summary' }),
    createUserMessage({ content: 'reminder', isMeta: true }),
    { ...createUserMessage({ content: 'VIRTUAL_UI' }), isVirtual: true },
  ]
  const before = structuredClone(messages)
  const projected = projectModApiMessages(messages)
  expect(projected).toHaveLength(1)
  expect(projected[0]?.role).toBe('user')
  expect(JSON.stringify(projected)).toContain('summary')
  expect(JSON.stringify(projected)).toContain('reminder')
  expect(JSON.stringify(projected)).not.toContain('OLD_PRIVATE_CONTEXT')
  expect(JSON.stringify(projected)).not.toContain('VIRTUAL_UI')
  expect(messages).toEqual(before)
})

test('API projection opens on a user and retains at most the newest 4096 normalized messages', () => {
  const messages = Array.from({ length: 4102 }, (_, index) =>
    index % 2 === 0
      ? createUserMessage({ content: `user ${index}` })
      : createAssistantMessage({ content: `assistant ${index}` }),
  )
  const api = projectModApiMessages(messages)
  expect(api).toHaveLength(4096)
  expect(api[0]).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'user 6' }],
  })
  expect(api.at(-1)).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'assistant 4101' }],
  })
  expect(
    projectModApiMessages([
      createAssistantMessage({ content: 'assistant first' }),
      createUserMessage({ content: 'first user' }),
    ]),
  ).toEqual([{ role: 'user', content: [{ type: 'text', text: 'first user' }] }])
})

test('API blocks remain independent of the source and omit per-send cache marks', () => {
  const user = createUserMessage({
    content: [
      { type: 'text', text: 'question', cache_control: { type: 'ephemeral' } },
    ],
  })
  const messages = [user]
  const projected = projectModApiMessages(messages)
  expect(projected[0]?.content[0]).toEqual({ type: 'text', text: 'question' })
  projected[0]!.content[0]!.text = 'modified consumer'
  expect((user.message.content as { text: string }[])[0]?.text).toBe('question')
})

test('a failed Agent that really started retains tracked identity without duration', () => {
  const messages = [
    createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'failed-agent', name: 'Agent', input: {} },
      ],
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'failed-agent',
          content: 'provider failed',
          is_error: true,
        },
      ],
    }),
  ]
  const summary = projectModSessionMessages(
    messages,
    4096,
    new Map([['failed-agent', 'started-child']]),
  )[0]?.toolUses[0]
  expect(summary).toHaveProperty('agentId', 'started-child')
  expect(summary).not.toHaveProperty('durationMs')
})

test('an older stored completed Agent record retains its measured duration without a status field', () => {
  const messages = [
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'legacy', name: 'Agent', input: {} }],
    }),
    createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'legacy', content: 'done' },
      ],
      toolUseResult: {
        agentId: 'legacy-child',
        totalDurationMs: 321,
        totalTokens: 7,
        totalToolUseCount: 0,
        content: [{ type: 'text', text: 'done' }],
        usage: {},
      },
    }),
  ]
  expect(projectModSessionMessages(messages)[0]?.toolUses[0]).toMatchObject({
    agentId: 'legacy-child',
    durationMs: 321,
  })
})
