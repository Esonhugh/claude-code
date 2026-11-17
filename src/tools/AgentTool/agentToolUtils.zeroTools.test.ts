import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
// Loads the Agent tool first, as the app does; agentToolUtils alone hits an init-order cycle.
import './AgentTool.js'
import { GOAL_TOOL_NAME } from '../GoalTool/constants.js'
import { resolveAgentTools, zeroToolSpawnRefusal } from './agentToolUtils.js'

const grepTool = { name: 'Grep' } as Tool
const goalTool = { name: GOAL_TOOL_NAME } as Tool
const agent = { agentType: 'norepl', source: 'projectSettings' as const }
const spawn = { isAsync: true, isContinuation: false }

test('a tools list that resolves to nothing refuses the spawn with the official text', () => {
  const resolution = resolveAgentTools({ ...agent, tools: ['Read', 'Bash'] }, [grepTool])
  expect(resolution.resolvedTools).toEqual([])
  expect(zeroToolSpawnRefusal(agent, resolution, 1, spawn)).toBe(
    "Agent 'norepl' would be spawned with zero tools \u2014 refusing. Its tools list resolved to nothing: unrecognized [Read, Bash]. Fix the agent's tools frontmatter or pass a different subagent_type.",
  )
})

test('a tool the session has but subagents may not use is named as such', () => {
  const resolution = resolveAgentTools({ ...agent, tools: [GOAL_TOOL_NAME, 'Nope'] }, [goalTool])
  expect(resolution.invalidTools).toEqual(['Nope'])
  expect(resolution.unavailableTools).toEqual([GOAL_TOOL_NAME])
  expect(zeroToolSpawnRefusal(agent, resolution, 1, spawn)).toContain(
    `resolved to nothing: unrecognized [Nope]; not available to subagents [${GOAL_TOOL_NAME}].`,
  )
})

test('a spec the agent disallows itself is dropped, not reported', () => {
  const resolution = resolveAgentTools({ ...agent, tools: ['Grep'], disallowedTools: ['Grep'] }, [grepTool])
  expect(resolution.invalidTools).toEqual([])
  expect(resolution.unavailableTools).toEqual([])
  expect(zeroToolSpawnRefusal(agent, resolution, 1, spawn)).toBeUndefined()
})

test('a wildcard, a continuation, an empty pool or exact tools only log it', () => {
  const named = resolveAgentTools({ ...agent, tools: ['Read'] }, [grepTool])
  const wildcard = resolveAgentTools({ ...agent, tools: ['*'], disallowedTools: ['Grep'] }, [grepTool])
  expect(zeroToolSpawnRefusal(agent, wildcard, 1, spawn)).toBeUndefined()
  expect(zeroToolSpawnRefusal(agent, named, 1, { ...spawn, isContinuation: true })).toBeUndefined()
  expect(zeroToolSpawnRefusal(agent, named, 0, spawn)).toBeUndefined()
  expect(zeroToolSpawnRefusal(agent, undefined, 1, spawn)).toBeUndefined()
})
