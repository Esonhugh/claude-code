import { afterEach, describe, expect, test } from 'bun:test'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from './types.js'

;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}
const { fetchToolsForClient, getMcpToolTimeoutMs } = await import('./client.js')

describe('per-server timeout', () => {
  const originalEnv = process.env.MCP_TOOL_TIMEOUT
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_TOOL_TIMEOUT
    else process.env.MCP_TOOL_TIMEOUT = originalEnv
  })

  const stdio = (timeout?: number): ScopedMcpServerConfig => ({
    type: 'stdio',
    command: 'echo',
    args: [],
    scope: 'user',
    ...(timeout !== undefined && { timeout }),
  })

  test('overrides MCP_TOOL_TIMEOUT', () => {
    process.env.MCP_TOOL_TIMEOUT = '2000'
    expect(getMcpToolTimeoutMs(stdio(5000))).toBe(5000)
    expect(getMcpToolTimeoutMs(stdio())).toBe(2000)
  })

  test('values below 1000ms fall through to MCP_TOOL_TIMEOUT or the default', () => {
    process.env.MCP_TOOL_TIMEOUT = '2000'
    expect(getMcpToolTimeoutMs(stdio(999))).toBe(2000)
    delete process.env.MCP_TOOL_TIMEOUT
    expect(getMcpToolTimeoutMs(stdio(999))).toBe(getMcpToolTimeoutMs())
    expect(getMcpToolTimeoutMs(stdio(1000))).toBe(1000)
  })
})

describe('server-level alwaysLoad', () => {
  let n = 0
  async function toolsFor(
    config: Partial<ScopedMcpServerConfig> & { scope: ScopedMcpServerConfig['scope'] },
  ) {
    const connection = {
      type: 'connected',
      name: `always-load-${n++}`,
      capabilities: { tools: {} },
      config: { type: 'stdio', command: 'echo', args: [], ...config },
      cleanup: async () => {},
      client: {
        request: async () => ({
          tools: [
            { name: 'plain', inputSchema: { type: 'object' } },
            {
              name: 'meta_true',
              inputSchema: { type: 'object' },
              _meta: { 'anthropic/alwaysLoad': true },
            },
            {
              name: 'meta_false',
              inputSchema: { type: 'object' },
              _meta: { 'anthropic/alwaysLoad': false },
            },
          ],
        }),
      },
    } as unknown as ConnectedMCPServer
    const tools = await fetchToolsForClient(connection)
    return Object.fromEntries(
      tools.map(t => [t.mcpInfo!.toolName, t.alwaysLoad === true]),
    )
  }

  test('unset: only tools that opt in via _meta load up front', async () => {
    expect(await toolsFor({ scope: 'user' })).toEqual({
      plain: false,
      meta_true: true,
      meta_false: false,
    })
  })

  test('true: every tool of a configured server loads up front', async () => {
    expect(await toolsFor({ scope: 'user', alwaysLoad: true })).toEqual({
      plain: true,
      meta_true: true,
      meta_false: true,
    })
  })

  test('true on a dynamic server: a tool can still opt out via _meta', async () => {
    expect(await toolsFor({ scope: 'dynamic', alwaysLoad: true })).toEqual({
      plain: true,
      meta_true: true,
      meta_false: false,
    })
  })

  test('false: every tool is deferred, even ones that opt in', async () => {
    expect(await toolsFor({ scope: 'user', alwaysLoad: false })).toEqual({
      plain: false,
      meta_true: false,
      meta_false: false,
    })
  })
})
