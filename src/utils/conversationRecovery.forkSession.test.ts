import { expect, mock, test } from 'bun:test'
import type { LogOption } from '../types/logs.js'

const calls: { source: string; sessionId?: string }[] = []
const real = await import('./sessionStart.js')
mock.module('./sessionStart.js', () => ({
  ...real,
  processSessionStartHooks: async (
    source: string,
    options: { sessionId?: string } = {},
  ) => {
    calls.push({ source, sessionId: options.sessionId })
    return []
  },
}))
const { loadConversationForResume } = await import('./conversationRecovery.js')
const { createUserMessage, createAssistantMessage } = await import(
  './messages.js'
)

const log = {
  date: '2026-11-07',
  messages: [
    createUserMessage({ content: 'hello' }),
    createAssistantMessage({ content: 'hi' }),
  ],
  value: 0,
  created: new Date(),
  modified: new Date(),
  firstPrompt: 'hello',
  messageCount: 2,
  isSidechain: false,
  sessionId: '11111111-1111-4111-8111-111111111111',
} as unknown as LogOption

test('--fork-session runs SessionStart with source fork and the new session id', async () => {
  calls.length = 0
  await loadConversationForResume(log, undefined)
  await loadConversationForResume(log, undefined, true)
  expect(calls).toEqual([
    { source: 'resume', sessionId: '11111111-1111-4111-8111-111111111111' },
    { source: 'fork', sessionId: undefined },
  ])
})
