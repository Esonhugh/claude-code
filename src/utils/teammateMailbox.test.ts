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
