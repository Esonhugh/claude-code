import { expect, test } from 'bun:test'

import { createOrphanedAgentNotices } from './conversationRecovery.js'
import { createUserMessage, extractTag } from './messages.js'

const launched = (agentId: string, description: string) =>
  createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: `toolu_${agentId}`, content: 'Async agent launched successfully.' }],
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, prompt: 'p' },
  })
const notified = (agentId: string) =>
  createUserMessage({
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`,
    origin: { kind: 'task-notification' },
  })
const resumed = (agentId: string) =>
  createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: `toolu_send_${agentId}`, content: 'ok' }],
    toolUseResult: { success: true, message: `Resuming agent ${agentId.slice(0, 7)}`, resumedAgentId: agentId },
  })

test('a worker still running when the previous session ended is reported as stopped, like official', () => {
  const notices = createOrphanedAgentNotices([
    launched('a1', 'done work'),
    notified('a1'),
    launched('a2', 'slow <work>'),
  ])
  expect(notices).toHaveLength(1)
  const notice = notices[0]!
  expect(notice.type).toBe('user')
  if (notice.type !== 'user') return
  expect(notice.origin).toEqual({ kind: 'task-notification' })
  const text = notice.message.content as string
  expect(extractTag(text, 'task-id')).toBe('a2')
  expect(extractTag(text, 'status')).toBe('stopped')
  expect(extractTag(text, 'summary')).toBe(
    `Background agent "slow &lt;work&gt;" didn't finish before the previous session ended`,
  )
  expect(text).toContain('Resume it by sending it a message with SendMessage')
})

test('a worker resumed with SendMessage and not notified again is an orphan; one that notified is not', () => {
  const messages = [launched('a1', 'alpha'), notified('a1'), resumed('a1')]
  expect(createOrphanedAgentNotices(messages).map(m => (m.type === 'user' ? extractTag(m.message.content as string, 'summary') : ''))).toEqual([
    `Background agent "alpha" didn't finish before the previous session ended`,
  ])
  expect(createOrphanedAgentNotices([...messages, notified('a1')])).toEqual([])
})

test('a mid-turn notification delivered as a queued_command attachment counts as delivered', () => {
  const attachment = {
    type: 'attachment',
    uuid: 'u1',
    timestamp: new Date().toISOString(),
    attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a3</task-id>\n<status>killed</status>\n</task-notification>' },
  }
  expect(createOrphanedAgentNotices([launched('a3', 'gamma'), attachment as never])).toEqual([])
})
