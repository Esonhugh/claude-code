import { expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { TranscriptMessage } from '../types/logs.js'
import { buildConversationChain } from './sessionStorage.js'

const entry = (uuid: string, parentUuid: string | null, extra: object) =>
  ({ uuid, parentUuid, sessionId: 's', timestamp: '2026-11-03T00:00:00Z', isSidechain: false, ...extra }) as unknown as TranscriptMessage

test('resume keeps the last turn duration row after the leaf, like official', () => {
  const user = entry('u1', null, { type: 'user', message: { role: 'user', content: 'P1' } })
  const reply = entry('a1', 'u1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
  const duration = entry('d1', 'a1', { type: 'system', subtype: 'turn_duration', durationMs: 5 })
  const messages = new Map<UUID, TranscriptMessage>([user, reply, duration].map(m => [m.uuid as UUID, m] as const))
  expect(buildConversationChain(messages, reply).map(m => String(m.uuid))).toEqual(['u1', 'a1', 'd1'])
})
