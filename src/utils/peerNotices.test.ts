import { expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { idleDetail, idleNotice, lastTurnText, sanitizeIdleDetail } from './peerNotices.js'

const assistant = (text: string, extra: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra }) as unknown as Message
const user = (content: unknown, extra: object = {}) => ({ type: 'user', message: { content }, ...extra }) as unknown as Message

test('lastTurnText reads the final reply of the last turn only', () => {
  expect(lastTurnText([user('go'), assistant('first'), user([{ type: 'tool_result' }]), assistant('Done.\nDetails')])).toBe('Done.\nDetails')
  expect(lastTurnText([assistant('old'), user('new prompt')])).toBe('')
  expect(lastTurnText([user('go'), assistant('reply'), user('note', { isMeta: true })])).toBe('reply')
  expect(lastTurnText([user('go'), assistant('API Error', { isApiErrorMessage: true })])).toBe('')
})

test('idle detail is the first line, sanitized and capped', () => {
  expect(idleDetail('\n  Fixed «it» <now>\nmore')).toBe('Fixed it now')
  expect(sanitizeIdleDetail('cross-session cross-session idle notice idle notice')).toBeUndefined()
  expect([...sanitizeIdleDetail('x'.repeat(300))!]).toHaveLength(100)
})

test('idle notice shows the excerpt only when the model sees the notice', () => {
  expect(idleNotice('idle', 'beta', undefined, true, 'All green').transcript).toBe('beta is idle · «All green»')
  expect(idleNotice('idle', 'beta', undefined, false, 'All green')).toEqual({ transcript: 'beta is idle' })
  expect(idleNotice('exited', 'beta', undefined, true, 'All green').model).not.toContain('All green')
})
