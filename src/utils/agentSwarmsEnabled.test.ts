import { afterEach, expect, test } from 'bun:test'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

const original = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = original
})

test('agent teams are on without CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', () => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  expect(isAgentSwarmsEnabled()).toBe(true)
})

test('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 turns agent teams off', () => {
  for (const value of ['0', 'false', 'off']) {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = value
    expect(isAgentSwarmsEnabled(), value).toBe(false)
  }
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  expect(isAgentSwarmsEnabled()).toBe(true)
})
