import { expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { checkResumeDropsTurn } from './resumeDropsTurn.js'

const TURN = '11111111-1111-4111-8111-111111111111'

const user = (uuid: string, content: unknown, extra: object = {}): Message =>
  ({ type: 'user', uuid, timestamp: '', message: { role: 'user', content }, ...extra }) as Message
const assistant = (uuid: string): Message =>
  ({ type: 'assistant', uuid, timestamp: '', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) as Message
const toolResult = (uuid: string): Message =>
  user(uuid, [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }])

test('accepts a discarded range that is only the declared turn', () => {
  expect(
    checkResumeDropsTurn([user(TURN, 'hi'), assistant('a1'), toolResult('u2'), assistant('a2')], TURN),
  ).toBeUndefined()
  expect(checkResumeDropsTurn([], TURN)).toBeUndefined()
})

test('refuses a range that starts with another prompt', () => {
  expect(checkResumeDropsTurn([user('other', 'hi'), assistant('a1')], TURN)).toStartWith(
    'range does not start with the declared turn prompt',
  )
})

test('refuses a range holding a prompt the caller had not seen', () => {
  expect(
    checkResumeDropsTurn([user(TURN, 'hi'), assistant('a1'), user('u3', 'queued follow-up')], TURN),
  ).toStartWith('range contains a user entry not attributable to the declared turn')
  expect(
    checkResumeDropsTurn(
      [user(TURN, 'hi'), user('u4', 'done', { origin: { kind: 'task-notification' } })],
      TURN,
    ),
  ).toStartWith('range contains an externally-sourced user entry')
  expect(
    checkResumeDropsTurn(
      [user(TURN, 'hi'), { type: 'attachment', uuid: 'x', attachment: { type: 'queued_command' } } as unknown as Message],
      TURN,
    ),
  ).toStartWith('range contains absorbed queued content')
})

test('refuses a declared id that is not a UUID', () => {
  expect(checkResumeDropsTurn([user(TURN, 'hi')], 'nope')).toBe('declared turn id is not a UUID: nope')
})

test('keeps interrupt markers and meta entries inside the turn', () => {
  expect(
    checkResumeDropsTurn(
      [user(TURN, 'hi'), assistant('a1'), user('u5', '[Request interrupted by user]'), user('u6', 'ctx', { isMeta: true })],
      TURN,
    ),
  ).toBeUndefined()
})
