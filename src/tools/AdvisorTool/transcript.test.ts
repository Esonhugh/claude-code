import { expect, test } from 'bun:test'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { fitAdvisorTranscript, renderAdvisorTranscript } from './transcript.js'

const user = (content: unknown) =>
  ({ type: 'user', message: { role: 'user', content } }) as unknown as UserMessage
const assistant = (content: unknown) =>
  ({ type: 'assistant', message: { role: 'assistant', content } }) as unknown as AssistantMessage

test('renders requests, replies, tool calls and their results in order', () => {
  const transcript = renderAdvisorTranscript([
    user('fix the login bug'),
    assistant([
      { type: 'thinking', thinking: 'PRIVATE_REASONING', signature: 'sig' },
      { type: 'text', text: 'Reading the handler.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/src/login.ts' } },
      { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'bun test' } },
    ]),
    user([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function login() {}' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        is_error: true,
        content: [
          { type: 'text', text: '1 fail' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
      { type: 'text', text: 'also check logout' },
    ]),
  ])
  expect(transcript).toBe(
    [
      '<user>',
      'fix the login bug',
      '</user>',
      '<assistant>',
      'Reading the handler.',
      '<tool_call name="Read">{"file_path":"/src/login.ts"}</tool_call>',
      '<tool_call name="Bash">{"command":"bun test"}</tool_call>',
      '</assistant>',
      '<tool_result name="Read">',
      'export function login() {}',
      '</tool_result>',
      '<tool_result name="Bash" error="true">',
      '1 fail',
      '[image]',
      '</tool_result>',
      '<user>',
      'also check logout',
      '</user>',
    ].join('\n'),
  )
})

test('joins the blocks of one streamed reply and leaves out the advisor call being answered', () => {
  const transcript = renderAdvisorTranscript([
    user('go'),
    assistant([{ type: 'tool_use', id: 'toolu_old', name: 'advisor', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'EARLIER_ADVICE' }]),
    assistant([{ type: 'text', text: 'Should I use A or B?' }]),
    assistant([{ type: 'tool_use', id: 'toolu_new', name: 'advisor', input: {} }]),
    assistant([{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: { pattern: 'x' } }]),
  ])
  expect(transcript).toBe(
    [
      '<user>',
      'go',
      '</user>',
      '<assistant>',
      '<tool_call name="advisor">{}</tool_call>',
      '</assistant>',
      '<tool_result name="advisor">',
      'EARLIER_ADVICE',
      '</tool_result>',
      '<assistant>',
      'Should I use A or B?',
      '<tool_call name="Grep">{"pattern":"x"}</tool_call>',
      '</assistant>',
    ].join('\n'),
  )
})

test('a transcript over the budget keeps its start and its latest part', () => {
  const transcript = `HEAD${'a'.repeat(1000)}${'b'.repeat(1000)}TAIL`
  expect(fitAdvisorTranscript(transcript, 5000)).toBe(transcript)
  const fitted = fitAdvisorTranscript(transcript, 500)
  expect(fitted.startsWith('HEAD')).toBe(true)
  expect(fitted.endsWith('TAIL')).toBe(true)
  expect(fitted).toContain('[1508 characters of the transcript left out to fit the advisor model]')
  expect(fitted.replace(/\n\[.*\]\n/, '')).toHaveLength(500)
})
