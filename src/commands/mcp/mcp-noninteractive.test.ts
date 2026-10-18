import { expect, test } from 'bun:test'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { call } from './mcp-noninteractive.js'

const config = { type: 'stdio' as const, command: 'echo', args: [], scope: 'local' as const }
const usage =
  'Usage: /mcp [reconnect|enable|disable [<server>|all]]. With no server name, applies to all.'

async function run(args: string, mcpClients: MCPServerConnection[]) {
  const context = { options: { mcpClients } } as unknown as LocalJSXCommandContext
  const result = await call(args, context)
  return result.type === 'text' ? result.value : result.type
}

const clients: MCPServerConnection[] = [
  { name: 'up', type: 'connected', config } as MCPServerConnection,
  { name: 'starting', type: 'pending', config },
  { name: 'broken', type: 'failed', config },
  { name: 'locked', type: 'needs-auth', config },
  { name: 'off', type: 'disabled', config },
  { name: 'ide', type: 'failed', config },
]

// Official 2.1.292 non-interactive /mcp (print mode).
test('/mcp summarises server status', async () => {
  expect(await run('', clients)).toBe(
    '5 MCP server(s): 1 connected, 1 connecting, 2 not connected, 1 disabled. Use `/mcp` in the terminal for details.',
  )
  expect(await run('status', clients)).toBe(await run('', clients))
})

test('/mcp with no servers', async () => {
  expect(await run('', [])).toBe(
    `No MCP servers are configured. Add one with \`claude mcp add\`.\n${usage}`,
  )
})

test('/mcp help and unknown actions', async () => {
  expect(await run('help', clients)).toBe(usage)
  expect(await run('frobnicate', clients)).toBe(
    `"frobnicate" isn't a recognized /mcp action. Try reconnect, enable, or disable.`,
  )
})

test('/mcp actions name a missing server', async () => {
  expect(await run('reconnect nope', clients)).toBe(
    `There's no MCP server named "nope". Run \`/mcp\` in the terminal to see configured servers.`,
  )
  expect(await run('enable all', [])).toBe(
    'No MCP servers are configured. Add one with `claude mcp add`.',
  )
})

test('/mcp actions are not available in print mode', async () => {
  for (const args of ['reconnect all', 'enable off', 'disable up']) {
    expect(await run(args, clients)).toBe(
      "Reconnect, enable, and disable aren't available in this session.",
    )
  }
})
