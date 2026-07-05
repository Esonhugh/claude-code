import assert from 'node:assert/strict'

import type { Tool } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import {
  getAvailableMcpServerNamesForTesting,
  getMissingRequiredMcpServersForTesting,
} from './mcpAvailability.js'

function mcpTool(name: string): Tool {
  return {
    name,
    async description() {
      return name
    },
  } as Tool
}

const agent: AgentDefinition = {
  agentType: 'needs-github',
  whenToUse: 'Use when GitHub MCP is required',
  source: 'projectSettings',
  baseDir: '/tmp/agents',
  requiredMcpServers: ['github'],
  getSystemPrompt: () => 'Use GitHub MCP',
}

assert.deepEqual(
  getAvailableMcpServerNamesForTesting({
    appStateMcpTools: [mcpTool('mcp__github__search')],
    currentToolPool: [],
  }),
  ['github'],
)

assert.deepEqual(
  getAvailableMcpServerNamesForTesting({
    appStateMcpTools: [],
    currentToolPool: [mcpTool('mcp__github__search')],
  }),
  ['github'],
)

assert.deepEqual(
  getAvailableMcpServerNamesForTesting({
    appStateMcpTools: [mcpTool('mcp__github__search')],
    currentToolPool: [mcpTool('mcp__github__repo'), mcpTool('Read')],
  }),
  ['github'],
)

assert.deepEqual(
  getMissingRequiredMcpServersForTesting({
    agent,
    availableServers: ['github'],
  }),
  [],
)

assert.deepEqual(
  getMissingRequiredMcpServersForTesting({
    agent,
    availableServers: [],
  }),
  ['github'],
)

assert.deepEqual(
  getMissingRequiredMcpServersForTesting({
    agent: { ...agent, requiredMcpServers: ['git'] },
    availableServers: ['github-enterprise'],
  }),
  [],
)

console.log('mcpAvailability.test.ts passed')
