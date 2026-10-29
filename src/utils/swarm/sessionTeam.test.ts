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
