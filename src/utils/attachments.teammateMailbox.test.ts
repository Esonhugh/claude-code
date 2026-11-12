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
  markMessagesAsRead: async (agentName: string) => {
    marked.push(agentName)
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

const { createTeammateContext, runWithTeammateContext } = await import('./teammateContext.js')

const leadState = () => ({
  ...getDefaultAppState(),
  teamContext: {
    teamName: 'mid-turn',
    teamFilePath: '/nonexistent/config.json',
    leadAgentId: 'team-lead@mid-turn',
    teammates: {},
  },
})

// Subagents, workflow agents and forks share the lead's AppState; reading the
// mailbox there marks the lead's messages read in the wrong model's context.
test('only the mailbox owner\'s own loop reads it', async () => {
  marked.length = 0
  const state = leadState()
  const sub = { agentId: 'asub', getAppState: () => state, setAppState: () => {} } as unknown as ToolUseContext
  expect(await getTeammateMailboxAttachments(sub)).toEqual([])

  const t1 = { type: 'in_process_teammate', status: 'running', identity: { agentId: 't1@mid-turn', agentName: 't1', teamName: 'mid-turn' } }
  const withTeammate = { ...state, tasks: { task1: t1 } } as unknown as typeof state
  const inTeammate = (agentId: string) => runWithTeammateContext(
    createTeammateContext({ agentId: 't1@mid-turn', agentName: 't1', teamName: 'mid-turn', planModeRequired: false, parentSessionId: 's', abortController: new AbortController() }),
    () => getTeammateMailboxAttachments({ agentId, getAppState: () => withTeammate, setAppState: () => {} } as unknown as ToolUseContext),
  )
  expect(await inTeammate('inner-sub')).toEqual([])
  expect(marked).toEqual([])
  expect((await inTeammate('t1@mid-turn')).length).toBe(1)
  expect(marked).toEqual(['t1'])
})

test('the lead viewing a teammate still reads its own mailbox, not the teammate\'s', async () => {
  marked.length = 0
  const t1 = { type: 'in_process_teammate', status: 'running', identity: { agentId: 't1@mid-turn', agentName: 't1', teamName: 'mid-turn' } }
  const state = { ...leadState(), tasks: { task1: t1 }, viewingAgentTaskId: 'task1' } as unknown as ReturnType<typeof leadState>
  const context = { getAppState: () => state, setAppState: () => {} } as unknown as ToolUseContext
  expect((await getTeammateMailboxAttachments(context)).length).toBe(1)
  expect(marked).toEqual(['team-lead'])
})
