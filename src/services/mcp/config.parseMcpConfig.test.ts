import { describe, expect, test } from 'bun:test'
import { parseMcpConfig } from './config.js'

function parse(mcpServers: unknown) {
  return parseMcpConfig({
    configObject: { mcpServers },
    expandVars: false,
    scope: 'project',
    filePath: '/repo/.mcp.json',
  })
}

describe('parseMcpConfig per-server validation', () => {
  test('an invalid entry is skipped with a warning; valid entries load', () => {
    const { config, errors } = parse({
      good: { command: 'echo', args: ['ok'] },
      bad: { type: 'stdio', command: '' },
      wrongType: { type: 'carrier-pigeon', url: 'https://x' },
    })
    expect(Object.keys(config?.mcpServers ?? {})).toEqual(['good'])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({
      file: '/repo/.mcp.json',
      path: 'mcpServers.bad',
      mcpErrorMetadata: {
        scope: 'project',
        serverName: 'bad',
        severity: 'warning',
        skipReason: 'invalid_config',
      },
    })
    expect(errors[0]!.message).toBe(
      'Skipped — invalid MCP server config for "bad": command: Command cannot be empty',
    )
    expect(errors[1]).toMatchObject({
      path: 'mcpServers.wrongType',
      mcpErrorMetadata: { serverName: 'wrongType', skipReason: 'unknown_type' },
    })
    expect(errors[1]!.message).toBe(
      'Skipped — unknown MCP server type "carrier-pigeon" for server "wrongType"',
    )
  })

  test('a url entry without a type gets a targeted hint', () => {
    const { config, errors } = parse({ remote: { url: 'https://x/mcp' } })
    expect(config?.mcpServers).toEqual({})
    expect(errors[0]!.message).toBe(
      'Skipped — MCP server "remote" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
    )
    expect(errors[0]!.mcpErrorMetadata?.skipReason).toBe('url_missing_type')
  })

  test('a non-object mcpServers is still fatal for the file', () => {
    const { config, errors } = parse(['not', 'a', 'record'])
    expect(config).toBeNull()
    expect(errors[0]!.mcpErrorMetadata?.severity).toBe('fatal')
  })

  test('timeout, alwaysLoad and oauth.scopes are kept', () => {
    const { config, errors } = parse({
      local: { command: 'echo', timeout: 5000, alwaysLoad: true },
      remote: {
        type: 'http',
        url: 'https://x/mcp',
        timeout: 120000,
        alwaysLoad: false,
        oauth: { clientId: 'cid', scopes: 'read write' },
      },
      zeroTimeout: { command: 'echo', timeout: 0 },
      emptyScopes: { type: 'sse', url: 'https://x', oauth: { scopes: '' } },
    })
    expect(config?.mcpServers.local).toMatchObject({
      timeout: 5000,
      alwaysLoad: true,
    })
    expect(config?.mcpServers.remote).toMatchObject({
      type: 'http',
      timeout: 120000,
      alwaysLoad: false,
      oauth: { clientId: 'cid', scopes: 'read write' },
    })
    expect(errors.map(e => e.mcpErrorMetadata?.serverName)).toEqual([
      'zeroTimeout',
      'emptyScopes',
    ])
  })

  test('bareElicitationCapability is kept on stdio, sse, http and ws', () => {
    const { config, errors } = parse({
      stdio: { command: 'echo', bareElicitationCapability: true },
      sse: { type: 'sse', url: 'https://x', bareElicitationCapability: true },
      http: { type: 'http', url: 'https://x', bareElicitationCapability: true },
      ws: { type: 'ws', url: 'wss://x', bareElicitationCapability: true },
    })
    expect(errors).toEqual([])
    for (const name of ['stdio', 'sse', 'http', 'ws']) {
      expect(config?.mcpServers[name]).toMatchObject({
        bareElicitationCapability: true,
      })
    }
  })
})
