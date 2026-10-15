import { expect, test } from 'bun:test'
import { sendDirectMemberMessage } from './directMemberMessage.js'

const teamContext = {
  teamName: 'direct-team',
  teamFilePath: '',
  leadAgentId: 'team-lead',
  teammates: { 'researcher@direct-team': { name: 'researcher' } },
} as unknown as Parameters<typeof sendDirectMemberMessage>[2]

test('a failed inbox write is not reported as sent', async () => {
  const result = await sendDirectMemberMessage('researcher', 'look again', teamContext, async () => false)
  expect(result).toEqual({ success: false, error: 'write_failed', recipientName: 'researcher' })
})

test('a written message is reported as sent', async () => {
  const written: unknown[] = []
  const result = await sendDirectMemberMessage('researcher', 'look again', teamContext, async (...args) => {
    written.push(args)
    return true
  })
  expect(result).toEqual({ success: true, recipientName: 'researcher' })
  expect(written).toHaveLength(1)
})
