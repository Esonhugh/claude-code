import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'

const configDir = mkdtempSync(join(tmpdir(), 'mailbox-race-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalTeams
  rmSync(configDir, { recursive: true, force: true })
})

const TEAM = 'race-team'
const realMailbox = { ...(await import('./teammateMailbox.js')) }
const message = (from: string) => ({ from, text: `${from} is done`, timestamp: `2026-11-12T14:00:0${from.length}.000Z` })
mock.module('./teammateMailbox.js', () => ({
  ...realMailbox,
  // bob's message lands right after the lead read its inbox.
  readUnreadMessages: async (agentName: string, teamName?: string) => {
    const unread = await realMailbox.readUnreadMessages(agentName, teamName)
    await realMailbox.writeToMailbox(agentName, message('bob'), teamName)
    return unread
  },
}))

const { getTeammateMailboxAttachments } = await import('./attachments.js')

test('a teammate message that arrives while the lead reads its inbox stays unread', async () => {
  await realMailbox.writeToMailbox('team-lead', message('alice'), TEAM)
  const state = {
    ...getDefaultAppState(),
    teamContext: { teamName: TEAM, teamFilePath: '/nonexistent/config.json', leadAgentId: `team-lead@${TEAM}`, teammates: {} },
  }
  const context = { getAppState: () => state, setAppState: () => {} } as unknown as ToolUseContext
  const [attachment] = await getTeammateMailboxAttachments(context)
  expect(attachment).toMatchObject({ type: 'teammate_mailbox', messages: [{ from: 'alice' }] })
  expect((await realMailbox.readUnreadMessages('team-lead', TEAM)).map(m => m.from)).toEqual(['bob'])
})
