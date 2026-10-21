import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
// Loads AgentTool before agentToolUtils, as the tool registry does.
import './AgentTool.js'
import { resolveAgentTools } from './agentToolUtils.js'

const readTool = { name: 'Read' } as Tool
const mcpTool = (serverName: string, toolName: string) =>
  ({ name: `mcp__${serverName}__${toolName}`, mcpInfo: { serverName, toolName } }) as unknown as Tool
const docsSearch = mcpTool('docs', 'search')
const docsFetch = mcpTool('docs', 'fetch')
const nestedServer = mcpTool('team__docs', 'search')
const other = mcpTool('other', 'run')

const resolve = (disallowedTools: string[]) =>
  resolveAgentTools(
    { disallowedTools, source: 'projectSettings' },
    [readTool, docsSearch, docsFetch, nestedServer, other],
    false,
  ).resolvedTools.map(tool => tool.name)

test('subagent disallowedTools take MCP server-level specs', () => {
  expect(resolve(['mcp__docs'])).toEqual(['Read', nestedServer.name, other.name])
  expect(resolve(['mcp__docs__*'])).toEqual(['Read', nestedServer.name, other.name])
  expect(resolve(['mcp__*'])).toEqual(['Read'])
  expect(resolve(['mcp__team__docs'])).toEqual(['Read', docsSearch.name, docsFetch.name, other.name])
})

test('subagent disallowedTools still match exact tool names', () => {
  expect(resolve(['mcp__docs__fetch', 'Read'])).toEqual([docsSearch.name, nestedServer.name, other.name])
})
