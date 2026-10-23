import { afterEach, expect, test } from 'bun:test'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

const original = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
const originalArgv = process.argv

afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = original
  process.argv = originalArgv
})

test('agent teams are off without CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', () => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  expect(isAgentSwarmsEnabled()).toBe(false)
})

test('a truthy CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS turns agent teams on', () => {
  for (const value of ['1', 'true']) {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = value
    expect(isAgentSwarmsEnabled(), value).toBe(true)
  }
})

test('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 keeps agent teams off', () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
  expect(isAgentSwarmsEnabled()).toBe(false)
})

test('--agent-teams turns agent teams on without the env var', () => {
  for (const value of [undefined, '0']) {
    if (value === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = value
    process.argv = [...originalArgv, '--agent-teams']
    expect(isAgentSwarmsEnabled(), String(value)).toBe(true)
  }
})
