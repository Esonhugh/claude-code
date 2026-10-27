import { expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
import { getMcpServerScopeFromTool } from './utils.js'

test('the scope comes from the tool own server, also when its name contains __', () => {
  const tool = {
    name: 'mcp__a__b__run',
    isMcp: true,
    mcpInfo: { serverName: 'a__b', toolName: 'run', scope: 'user' },
  } as Tool
  expect(getMcpServerScopeFromTool(tool)).toBe('user')
  expect(getMcpServerScopeFromTool({ name: 'Read' } as Tool)).toBeNull()
})
