import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
import { AgentTool } from './AgentTool.js'
import { SET_GOAL_TOOL_NAME } from '../SetGoalTool/constants.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { AGENT_TOOL_NAME } from './constants.js'

const agentTool = AgentTool
const readTool = { name: 'Read' } as Tool
const goalTool = { name: SET_GOAL_TOOL_NAME } as Tool
const specification = 'Agent(worker, researcher)'

for (const source of ['built-in', 'projectSettings', 'plugin'] as const) {
  for (const isAsync of [false, true]) {
    test(`${source} ${isAsync ? 'background' : 'foreground'} resolves an available nested Agent`, () => {
      const result = resolveAgentTools(
        { tools: [specification, 'Read'], source },
        [agentTool, readTool],
        isAsync,
      )
      expect(result).toEqual({
        hasWildcard: false,
        validTools: [specification, 'Read'],
        invalidTools: [],
        resolvedTools: [agentTool, readTool],
        allowedAgentTypes: ['worker', 'researcher'],
      })
      expect(result.resolvedTools[0]).toBe(agentTool)
    })
  }
}

for (const isAsync of [false, true]) {
  for (const disallowedTools of [undefined, [AGENT_TOOL_NAME], ['Agent(worker)']]) {
    test(`withheld nested Agent retains type metadata without granting the tool: ${isAsync}, ${disallowedTools}`, () => {
      const result = resolveAgentTools(
        { tools: [specification, 'Read'], disallowedTools, source: 'projectSettings' },
        disallowedTools ? [agentTool, readTool] : [readTool],
        isAsync,
      )
      expect(result).toEqual({
        hasWildcard: false,
        validTools: [specification, 'Read'],
        invalidTools: [],
        resolvedTools: [readTool],
        allowedAgentTypes: ['worker', 'researcher'],
      })
    })
  }
}

test('main-thread Agent follows normal availability resolution', () => {
  expect(resolveAgentTools(
    { tools: [specification], source: 'projectSettings' }, [agentTool], false, true,
  )).toEqual({
    hasWildcard: false, validTools: [specification], invalidTools: [],
    resolvedTools: [agentTool], allowedAgentTypes: ['worker', 'researcher'],
  })
  expect(resolveAgentTools(
    { tools: [specification], source: 'projectSettings' }, [], false, true,
  )).toEqual({
    hasWildcard: false, validTools: [], invalidTools: [specification],
    resolvedTools: [], allowedAgentTypes: ['worker', 'researcher'],
  })
})

test('a bare Agent declaration resolves in both foreground and background children', () => {
  for (const isAsync of [false, true]) {
    expect(resolveAgentTools(
      { tools: [AGENT_TOOL_NAME], source: 'projectSettings' }, [agentTool], isAsync,
    )).toEqual({
      hasWildcard: false, validTools: [AGENT_TOOL_NAME], invalidTools: [],
      resolvedTools: [agentTool], allowedAgentTypes: undefined,
    })
  }
})

test('repeated Agent declarations resolve the available tool once', () => {
  const result = resolveAgentTools(
    { tools: [specification, specification], source: 'projectSettings' }, [agentTool],
  )
  expect(result.validTools).toEqual([specification, specification])
  expect(result.resolvedTools).toEqual([agentTool])
})

for (const tools of [undefined, ['*']]) {
  test(`wildcard tool resolution preserves the filtered pool: ${tools}`, () => {
    const result = resolveAgentTools(
      { tools, disallowedTools: ['Read'], source: 'projectSettings' },
      [agentTool, readTool, goalTool],
    )
    expect(result).toEqual({
      hasWildcard: true, validTools: [], invalidTools: [], resolvedTools: [agentTool],
    })
  })
}

test('nested Agent availability does not bypass adjacent main-thread tool restrictions', () => {
  const result = resolveAgentTools(
    { tools: [specification, SET_GOAL_TOOL_NAME], source: 'built-in' },
    [agentTool, goalTool],
  )
  expect(result).toEqual({
    hasWildcard: false, validTools: [specification], invalidTools: [SET_GOAL_TOOL_NAME],
    resolvedTools: [agentTool], allowedAgentTypes: ['worker', 'researcher'],
  })
})
