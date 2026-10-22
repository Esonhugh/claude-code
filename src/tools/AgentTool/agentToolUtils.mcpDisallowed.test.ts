import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
import './AgentTool.js'
import { resolveAgentTools } from './agentToolUtils.js'

const readTool = { name: 'Read' } as Tool
const mcpTool = (serverName: string, toolName: string) =>
  ({ name: `mcp__${serverName}__${toolName}`, mcpInfo: { serverName, toolName } }) as Tool
const a = mcpTool('a', 'run')
const ab = mcpTool('a__b', 'run')
const other = mcpTool('other', 'run')
const ctor = mcpTool('constructor', 'run')

const remaining = (disallowedTools: string[]) =>
  resolveAgentTools(
    { disallowedTools, source: 'projectSettings' },
    [readTool, a, ab, other, ctor],
    false,
  ).resolvedTools.map(tool => tool.name)

test('server-level MCP specs in disallowedTools remove that server', () => {
  expect(remaining(['mcp__other'])).toEqual(['Read', a.name, ab.name, ctor.name])
  expect(remaining(['mcp__other__*'])).toEqual(['Read', a.name, ab.name, ctor.name])
  expect(remaining(['mcp__constructor'])).toEqual(['Read', a.name, ab.name, other.name])
})

test('mcp__* in disallowedTools removes every MCP tool', () => {
  expect(remaining(['mcp__*'])).toEqual(['Read'])
})

test('disallowedTools reach a server whose name contains __, and stay broad like deny rules', () => {
  expect(remaining(['mcp__a__b'])).toEqual(['Read', a.name, other.name, ctor.name])
  expect(remaining(['mcp__a__b__*'])).toEqual(['Read', a.name, other.name, ctor.name])
  expect(remaining(['mcp__a'])).toEqual(['Read', other.name, ctor.name])
})

test('a full MCP tool name in disallowedTools still removes only that tool', () => {
  expect(remaining([other.name, 'Read'])).toEqual([a.name, ab.name, ctor.name])
})
