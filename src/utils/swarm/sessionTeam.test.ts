import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = await mkdtemp(join(tmpdir(), 'session-team-'))
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(async () => {
  await rm(configDir, { recursive: true, force: true })
})

const { getSessionId } = await import('../../bootstrap/state.js')
const { getTasksDir, getTaskListId } = await import('../tasks.js')
const { readTeamFileAsync } = await import('./teamHelpers.js')
const { ensureSessionTeam, getSessionTeamName } = await import('./sessionTeam.js')
type AppState = import('../../state/AppStateStore.js').AppState

function fakeState() {
  let state = {} as AppState
  return {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }
}

test('ensureSessionTeam creates session-<id> with the leader and keeps session tasks', async () => {
  const sessionId = getSessionId()
  await mkdir(getTasksDir(sessionId), { recursive: true })
  await writeFile(join(getTasksDir(sessionId), '1.json'), '{}')

  const { getAppState, setAppState } = fakeState()
  const teamName = await ensureSessionTeam(getAppState, setAppState)

  expect(teamName).toBe(`session-${sessionId.slice(0, 8)}`)
  expect(getSessionTeamName()).toBe(teamName)
  const teamFile = await readTeamFileAsync(teamName)
  expect(teamFile?.leadAgentId).toBe(`team-lead@${teamName}`)
  expect(teamFile?.leadSessionId).toBe(sessionId)
  expect(teamFile?.members.map(m => m.name)).toEqual(['team-lead'])
  expect(teamFile?.members[0]?.backendType).toBe('in-process')
  expect(getAppState().teamContext?.teamName).toBe(teamName)
  expect(getAppState().teamContext?.leadAgentId).toBe(`team-lead@${teamName}`)
  expect(getTaskListId()).toBe(teamName)
  expect(existsSync(join(getTasksDir(teamName), '1.json'))).toBe(true)
  expect(existsSync(getTasksDir(sessionId))).toBe(false)
})

test('ensureSessionTeam drops the previous run\'s in-process members on resume (#802)', async () => {
  const teamName = getSessionTeamName()
  const previous = await readTeamFileAsync(teamName)
  if (!previous) throw new Error('team file missing')
  const member = (name: string, backendType: 'in-process' | 'tmux') => ({
    agentId: `${name}@${teamName}`,
    name,
    agentType: 'general-purpose',
    joinedAt: 1,
    tmuxPaneId: name,
    cwd: '/work',
    subscriptions: [],
    backendType,
  })
  const { writeTeamFileAsync } = await import('./teamHelpers.js')
  await writeTeamFileAsync(teamName, {
    ...previous,
    members: [...previous.members, member('ghost', 'in-process'), member('pane', 'tmux')],
  })

  const { getAppState, setAppState } = fakeState()
  expect(await ensureSessionTeam(getAppState, setAppState)).toBe(teamName)

  const teamFile = await readTeamFileAsync(teamName)
  expect(teamFile?.members.map(m => m.name)).toEqual(['team-lead', 'pane'])
  expect(teamFile?.members[0]?.backendType).toBe('in-process')
})

test('ensureSessionTeam keeps a team the leader already has', async () => {
  const { getAppState, setAppState } = fakeState()
  setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName: 'explicit',
      teamFilePath: '',
      leadAgentId: 'team-lead@explicit',
      teammates: {},
    },
  }))
  expect(await ensureSessionTeam(getAppState, setAppState)).toBe('explicit')
  expect(getAppState().teamContext?.teamName).toBe('explicit')
})
