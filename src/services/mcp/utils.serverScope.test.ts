import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
import { excludeToolsByServer, filterToolsByServer, getMcpServerScopeFromTool } from './utils.js'

test('the scope comes from the tool own server, also when its name contains __', () => {
  const tool = {
    name: 'mcp__a__b__run',
    isMcp: true,
    mcpInfo: { serverName: 'a__b', toolName: 'run', scope: 'user' },
  } as Tool
  expect(getMcpServerScopeFromTool(tool)).toBe('user')
  expect(getMcpServerScopeFromTool({ name: 'Read' } as Tool)).toBeNull()
})

test('a server owns only its own tools when another server name starts with it and __', () => {
  const tools = [
    { name: 'mcp__w__y', mcpInfo: { serverName: 'w', toolName: 'y' } },
    { name: 'mcp__w__x__y', mcpInfo: { serverName: 'w__x', toolName: 'y' } },
    { name: 'mcp__w__legacy' },
  ] as Tool[]
  expect(filterToolsByServer(tools, 'w').map(t => t.name)).toEqual(['mcp__w__y', 'mcp__w__legacy'])
  expect(filterToolsByServer(tools, 'w__x').map(t => t.name)).toEqual(['mcp__w__x__y'])
  // Reconnecting w replaces only w's tools.
  expect(excludeToolsByServer(tools, 'w').map(t => t.name)).toEqual(['mcp__w__x__y'])
})
