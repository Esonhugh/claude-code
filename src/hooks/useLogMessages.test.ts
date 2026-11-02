import { afterEach, expect, test } from 'bun:test'
import { transcriptTeamInfo } from './useLogMessages.js'

const original = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = original
})

test('the lead session transcript is not stamped with its team, so --continue still finds it', () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  expect(transcriptTeamInfo('session-12345678', undefined)).toEqual({})
  expect(transcriptTeamInfo(undefined, undefined)).toEqual({})
})

test('a teammate session transcript carries its team and agent name', () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  expect(transcriptTeamInfo('session-12345678', 'alpha')).toEqual({
    teamName: 'session-12345678',
    agentName: 'alpha',
  })
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  expect(transcriptTeamInfo('session-12345678', 'alpha')).toEqual({})
})
