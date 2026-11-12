import { afterAll, expect, mock, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'

const realMailbox = await import('../utils/teammateMailbox.js')
let read = false
mock.module('../utils/teammateMailbox.js', () => ({
  ...realMailbox,
  // A slow read under load: the next 1 s tick starts before this poll marks.
  readUnreadMessages: async () => {
    const unread = read ? [] : [{ from: 't1', text: 'LEAK-REP', timestamp: '2026-11-12T13:00:00.000Z', read: false }]
    await new Promise(resolve => setTimeout(resolve, 1200))
    return unread
  },
  markMessagesAsRead: async () => {
    read = true
  },
}))

const originalTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
afterAll(() => {
  if (originalTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalTeams
})

const { render } = await import('../ink.js')
const { AppStateProvider } = await import('../state/AppState.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { useInboxPoller } = await import('./useInboxPoller.js')

test('overlapping inbox polls deliver a teammate report to the lead once', async () => {
  const submitted: string[] = []
  function Lead(): React.ReactNode {
    useInboxPoller({ enabled: true, isLoading: false, focusedInputDialog: undefined, onSubmitMessage: text => { submitted.push(text); return true } })
    return null
  }
  const initialState = {
    ...getDefaultAppState(),
    teamContext: { teamName: 'overlap', teamFilePath: '/nonexistent/config.json', leadAgentId: 'team-lead@overlap', teammates: {} },
  }
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 20, isTTY: false })
  stdout.resume()
  const instance = await render(<AppStateProvider initialState={initialState}><Lead /></AppStateProvider>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 3000))
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('LEAK-REP')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}, 10_000)
