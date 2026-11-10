import { expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import { hasOtherTeammates } from './teammate.js'

const lead = 'team-lead@session-abc'
const teammate = (name: string) =>
  ({
    name,
    agentType: 'general-purpose',
    color: 'blue',
    tmuxSessionName: 'in-process',
    tmuxPaneId: name,
    cwd: '/work',
    spawnedAt: 1,
  }) as unknown as NonNullable<AppState['teamContext']>['teammates'][string]

function context(ids: string[]): AppState['teamContext'] {
  return {
    teamName: 'session-abc',
    teamFilePath: '',
    leadAgentId: lead,
    teammates: Object.fromEntries(ids.map(id => [id, teammate(id)])),
  }
}

test('a team whose only member is the leader has no other teammates (#798)', () => {
  expect(hasOtherTeammates(undefined)).toBe(false)
  expect(hasOtherTeammates(context([]))).toBe(false)
  expect(hasOtherTeammates(context([lead]))).toBe(false)
})

test('any member besides the leader counts', () => {
  expect(hasOtherTeammates(context([lead, 'worker@session-abc']))).toBe(true)
  expect(hasOtherTeammates(context(['worker@session-abc']))).toBe(true)
})
