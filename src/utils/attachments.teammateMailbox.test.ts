import { afterAll, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'

const realMailbox = await import('./teammateMailbox.js')
const unread = [
  { from: 'dates', text: 'Fixed dates.py; focused tests pass.', timestamp: '2026-11-12T13:00:00.000Z', read: false },
]
const marked: string[] = []
mock.module('./teammateMailbox.js', () => ({
  ...realMailbox,
  readUnreadMessages: async () => unread,
  markMessagesAsReadByPredicate: async (agentName: string) => {
    marked.push(agentName)
    return true
  },
}))

const originalTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
const originalUserType = process.env.USER_TYPE
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
delete process.env.USER_TYPE
afterAll(() => {
  if (originalTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalTeams
  if (originalUserType !== undefined) process.env.USER_TYPE = originalUserType
})

const { getTeammateMailboxAttachments } = await import('./attachments.js')

// A lead busy in a long turn must see teammate reports between its tool calls,
// or it keeps polling them and messaging teammates for status.
test('the team lead gets teammate messages mid-turn', async () => {
  const state = {
    ...getDefaultAppState(),
    teamContext: {
      teamName: 'mid-turn',
      teamFilePath: '/nonexistent/config.json',
      leadAgentId: 'team-lead@mid-turn',
      teammates: {},
    },
  }
  const context = { getAppState: () => state, setAppState: () => {} } as unknown as ToolUseContext
  expect(await getTeammateMailboxAttachments(context)).toEqual([
    { type: 'teammate_mailbox', messages: [{ from: 'dates', text: unread[0]!.text, timestamp: unread[0]!.timestamp, color: undefined, summary: undefined }] },
  ])
  expect(marked).toEqual(['team-lead'])
})
