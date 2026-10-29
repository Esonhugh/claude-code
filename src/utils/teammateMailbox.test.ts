import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = await mkdtemp(join(tmpdir(), 'teammate-mailbox-'))
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(async () => {
  await rm(configDir, { recursive: true, force: true })
})

const lockfile = await import('./lockfile.js')
const {
  clearMailbox,
  getInboxPath,
  markMessagesAsRead,
  readMailbox,
  readUnreadMessages,
  writeToMailbox,
} = await import('./teammateMailbox.js')

const TEAM = 'mailbox-team'
const message = (text: string) => ({
  from: 'researcher',
  text,
  timestamp: '2026-10-05T00:00:00.000Z',
})

test('markMessagesAsRead drops already-read messages when rewriting the inbox', async () => {
  expect(await writeToMailbox('lead', message('a'), TEAM)).toBe(true)
  expect(await writeToMailbox('lead', message('b'), TEAM)).toBe(true)
  await markMessagesAsRead('lead', TEAM, await readUnreadMessages('lead', TEAM))
  expect((await readMailbox('lead', TEAM)).map(m => [m.text, m.read])).toEqual([
    ['a', true],
    ['b', true],
  ])

  expect(await writeToMailbox('lead', message('c'), TEAM)).toBe(true)
  const unread = await readUnreadMessages('lead', TEAM)
  expect(unread.map(m => m.text)).toEqual(['c'])
  await markMessagesAsRead('lead', TEAM, unread)
  expect((await readMailbox('lead', TEAM)).map(m => [m.text, m.read])).toEqual([
    ['c', true],
  ])
})

test('markMessagesAsRead keeps a message that arrived after the poll read the inbox', async () => {
  expect(await writeToMailbox('racer', message('a'), TEAM)).toBe(true)
  const polled = await readUnreadMessages('racer', TEAM)
  expect(await writeToMailbox('racer', message('late'), TEAM)).toBe(true)
  await markMessagesAsRead('racer', TEAM, polled)
  expect((await readUnreadMessages('racer', TEAM)).map(m => m.text)).toEqual(['late'])
})

test('clearMailbox waits for the inbox lock instead of racing writers', async () => {
  expect(await writeToMailbox('locked', message('a'), TEAM)).toBe(true)
  const inboxPath = getInboxPath('locked', TEAM)
  const release = await lockfile.lock(inboxPath, { lockfilePath: `${inboxPath}.lock` })
  let cleared = false
  const clearing = clearMailbox('locked', TEAM).then(() => {
    cleared = true
  })
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(cleared).toBe(false)
  expect(await readMailbox('locked', TEAM)).toHaveLength(1)
  await release()
  await clearing
  expect(await readMailbox('locked', TEAM)).toEqual([])
})

const { createIdleNotification, getIdleResult } = await import('./teammateMailbox.js')
type Msg = Parameters<typeof getIdleResult>[0][number]
const user = (content: unknown): Msg => ({ type: 'user', message: { role: 'user', content } }) as unknown as Msg
const assistant = (...content: unknown[]): Msg => ({ type: 'assistant', message: { role: 'assistant', content } }) as unknown as Msg
const text = (t: string) => ({ type: 'text', text: t })
const sendTo = (id: string, to: string) => ({ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'hi' } })
const result = (id: string, is_error = false) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error }])

test('getIdleResult returns the last text reply of the current turn only', () => {
  expect(getIdleResult([
    user('first task'),
    assistant(text('old answer')),
    user('<teammate-message>second task</teammate-message>'),
    assistant(text('working'), { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
    result('t1'),
    assistant(text('part one'), text('part two')),
  ])).toBe('part one\npart two')
  expect(getIdleResult([user('task'), assistant(text('done')), user('next'), assistant({ type: 'tool_use', id: 't', name: 'Bash', input: {} })])).toBeUndefined()
})

test('getIdleResult is empty when the teammate already reported to the lead after its reply', () => {
  expect(getIdleResult([user('task'), assistant(text('summary')), assistant(sendTo('s1', 'team-lead')), result('s1')])).toBeUndefined()
  // a failed DM, or one to a peer, does not count as reporting to the lead
  expect(getIdleResult([user('task'), assistant(text('summary')), assistant(sendTo('s1', 'team-lead')), result('s1', true)])).toBe('summary')
  expect(getIdleResult([user('task'), assistant(text('summary')), assistant(sendTo('s1', 'peer')), result('s1')])).toBe('summary')
  // a DM before the final reply does not suppress the reply
  expect(getIdleResult([user('task'), assistant(sendTo('s1', 'team-lead')), result('s1'), assistant(text('final'))])).toBe('final')
})

test('createIdleNotification caps the result like official', () => {
  const long = 'x'.repeat(4001)
  expect(createIdleNotification('mate', { idleReason: 'available', result: long }).result).toBe(
    `${'x'.repeat(4000)}\n[result truncated — ask the agent for the rest via SendMessage]`,
  )
  expect(createIdleNotification('mate', { idleReason: 'failed', result: long }).result).toBe(`${'x'.repeat(4000)}\n[result truncated]`)
  expect(createIdleNotification('mate', { result: '  short  ' }).result).toBe('short')
  expect(createIdleNotification('mate', { result: '   ' }).result).toBeUndefined()
})
