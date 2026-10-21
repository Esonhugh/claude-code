import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = await mkdtemp(join(tmpdir(), 'team-helpers-'))
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(async () => {
  await rm(configDir, { recursive: true, force: true })
})

const {
  readTeamFileAsync,
  removeMemberByAgentId,
  removeMemberFromTeam,
  removeTeammateFromTeamFile,
  setMemberMode,
  setMultipleMemberModes,
  addHiddenPaneId,
  removeHiddenPaneId,
  writeTeamFileAsync,
} = await import('./teamHelpers.js')

const TEAM = 'helpers-team'

function member(name: string, tmuxPaneId: string) {
  return {
    agentId: `${name}@${TEAM}`,
    name,
    joinedAt: 1,
    tmuxPaneId,
    cwd: '/tmp',
    subscriptions: [],
  }
}

beforeEach(async () => {
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt: 1,
    leadAgentId: `team-lead@${TEAM}`,
    members: [member('team-lead', '%0'), member('researcher', '%1'), member('writer', '%2')],
  })
})

test('removeMemberByAgentId removes the member from a real team file', async () => {
  expect(await removeMemberByAgentId(TEAM, `researcher@${TEAM}`)).toBe(true)
  const names = (await readTeamFileAsync(TEAM))!.members.map(m => m.name)
  expect(names).toEqual(['team-lead', 'writer'])
  expect(await removeMemberByAgentId(TEAM, `researcher@${TEAM}`)).toBe(false)
})

test('removeTeammateFromTeamFile and removeMemberFromTeam mutate the team file', async () => {
  expect(await removeTeammateFromTeamFile(TEAM, { name: 'writer' })).toBe(true)
  expect(await removeMemberFromTeam(TEAM, '%1')).toBe(true)
  const names = (await readTeamFileAsync(TEAM))!.members.map(m => m.name)
  expect(names).toEqual(['team-lead'])
})

test('mode and hidden pane mutations persist to the team file', async () => {
  expect(await setMemberMode(TEAM, 'researcher', 'plan')).toBe(true)
  expect(await setMultipleMemberModes(TEAM, [
    { memberName: 'writer', mode: 'acceptEdits' },
  ])).toBe(true)
  expect(await addHiddenPaneId(TEAM, '%1')).toBe(true)
  let teamFile = (await readTeamFileAsync(TEAM))!
  expect(teamFile.members.find(m => m.name === 'researcher')?.mode).toBe('plan')
  expect(teamFile.members.find(m => m.name === 'writer')?.mode).toBe('acceptEdits')
  expect(teamFile.hiddenPaneIds).toEqual(['%1'])
  expect(await removeHiddenPaneId(TEAM, '%1')).toBe(true)
  teamFile = (await readTeamFileAsync(TEAM))!
  expect(teamFile.hiddenPaneIds).toEqual([])
})

test('mutations on a missing team return false', async () => {
  expect(await removeMemberByAgentId('no-such-team', 'x@no-such-team')).toBe(false)
  expect(await setMemberMode('no-such-team', 'x', 'plan')).toBe(false)
})

test('a lead mode switch is reported as not reaching teammates on another mode', async () => {
  const { teammatesKeepOtherMode } = await import('./teamHelpers.js')
  const inProcess = { name: 'a', tmuxPaneId: 'in-process' }
  // The lead's own entry (empty pane id) is not a pane teammate.
  const lead = { name: 'team-lead', tmuxPaneId: '' }
  expect(teammatesKeepOtherMode('default', [], undefined)).toBe(false)
  expect(teammatesKeepOtherMode('default', ['default'], { lead, a: inProcess })).toBe(false)
  expect(teammatesKeepOtherMode('default', ['default'], { a: inProcess })).toBe(false)
  expect(teammatesKeepOtherMode('default', ['acceptEdits'], { a: inProcess })).toBe(true)
  expect(teammatesKeepOtherMode('plan', ['default'], { a: inProcess })).toBe(true)
  // In-process teammates follow a lead in bypass, acceptEdits or auto.
  expect(teammatesKeepOtherMode('auto', ['default'], { a: inProcess })).toBe(false)
  expect(teammatesKeepOtherMode('bypassPermissions', ['plan'], { a: inProcess })).toBe(false)
  expect(teammatesKeepOtherMode('auto', [], { lead, b: { name: 'b', tmuxPaneId: '%3' } })).toBe(true)
})
