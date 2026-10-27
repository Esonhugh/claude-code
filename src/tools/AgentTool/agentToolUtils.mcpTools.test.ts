import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
import './AgentTool.js'
import { resolveAgentTools } from './agentToolUtils.js'

const readTool = { name: 'Read' } as Tool
const mcpTool = (serverName: string, toolName: string) =>
  ({ name: `mcp__${serverName}__${toolName}`, mcpInfo: { serverName, toolName } }) as Tool
const a1 = mcpTool('a', 'one')
const a2 = mcpTool('a', 'two')
const ab = mcpTool('a__b', 'run')
const other = mcpTool('other', 'run')

const resolve = (tools: string[]) => {
  const result = resolveAgentTools({ tools, source: 'projectSettings' }, [readTool, a1, a2, ab, other], false)
  return { names: result.resolvedTools.map(tool => tool.name), valid: result.validTools, invalid: result.invalidTools }
}

test('mcp__server and mcp__server__* in agent tools grant every tool of that server', () => {
  expect(resolve(['Read', 'mcp__a'])).toEqual({ names: ['Read', a1.name, a2.name], valid: ['Read', 'mcp__a'], invalid: [] })
  expect(resolve(['mcp__a__*'])).toEqual({ names: [a1.name, a2.name], valid: ['mcp__a__*'], invalid: [] })
})

test('a server whose name contains __ is granted by its full name with __*, not by its first segment', () => {
  expect(resolve(['mcp__a__b__*']).names).toEqual([ab.name])
  expect(resolve(['mcp__a']).names).not.toContain(ab.name)
})

test('a server-level spec with no connected tools stays valid and grants nothing', () => {
  expect(resolve(['mcp__missing'])).toEqual({ names: [], valid: ['mcp__missing'], invalid: [] })
})

test('a full MCP tool name still grants only that tool', () => {
  expect(resolve([a1.name]).names).toEqual([a1.name])
})
