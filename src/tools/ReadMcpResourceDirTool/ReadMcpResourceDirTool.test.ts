import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { CODEX_APPS_PLUGIN_RUNTIME_MCP_URL } from '../../services/apps/types.js'
import { markHostOwnedCodexAppsConfig } from '../../services/apps/trust.js'
import { createMcpSkillResourceRules } from '../../skills/mcpSkillResourceGrant.js'
import {
  DIRECTORY_READ_MIME_TYPE,
  MCP_SKILLS_EXTENSION,
  readMcpDirectory,
  serverDeclaresDirectoryRead,
} from '../../services/mcp/directoryRead.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../../services/mcp/types.js'
import { isAutoModeAllowlistedTool } from '../../utils/permissions/classifierDecision.js'
import { createStreamlinedTransformer } from '../../utils/streamlinedTransform.js'
import { READ_MCP_RESOURCE_DIR_TOOL_NAME } from './prompt.js'
import { ReadMcpResourceDirTool } from './ReadMcpResourceDirTool.js'

function connectedServer({
  name = 'demo',
  capabilities = {
    resources: {},
    extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
  },
  request = async () => ({ resources: [] }),
  config = { type: 'sdk' as const, name: 'demo', scope: 'local' as const },
}: {
  name?: string
  capabilities?: ConnectedMCPServer['capabilities']
  request?: (
    request: {
      method: string
      params?: Record<string, unknown>
    },
    schema?: unknown,
    options?: { timeout?: number },
  ) => Promise<unknown>
  config?: ConnectedMCPServer['config']
} = {}): ConnectedMCPServer {
  return {
    name,
    type: 'connected',
    capabilities,
    config,
    client: { request } as unknown as ConnectedMCPServer['client'],
    cleanup: async () => {},
  }
}

function dirToolContext(
  mcpClients: MCPServerConnection[],
  rules: string[] = [],
) {
  return {
    options: { mcpClients },
    getAppState: () => ({
      toolPermissionContext: {
        alwaysAllowRules: { command: rules },
      },
    }),
  } as never
}

async function callDirTool(
  input: { server: string; uri: string },
  mcpClients: MCPServerConnection[],
  rules: string[] = [],
) {
  return ReadMcpResourceDirTool.call(input, dirToolContext(mcpClients, rules))
}

describe('MCP directory read helper', () => {
  it('detects the skills extension directoryRead capability exactly', () => {
    assert.equal(
      serverDeclaresDirectoryRead({
        extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
      }),
      true,
    )
    assert.equal(
      serverDeclaresDirectoryRead({
        extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: false } },
      }),
      false,
    )
    assert.equal(
      serverDeclaresDirectoryRead({
        extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: 'true' } },
      } as never),
      false,
    )
  })

  it('requests the first page with only uri and later pages with cursor', async () => {
    const calls: Array<{
      request: { method: string; params?: Record<string, unknown> }
      timeout: number | undefined
    }> = []
    const server = connectedServer({
      request: async (request, _schema, options) => {
        calls.push({ request, timeout: options?.timeout })
        if (calls.length === 1) {
          return {
            resources: [{ uri: 'skill://demo/a', name: 'a.txt' }],
            nextCursor: 'cursor-1',
          }
        }
        return {
          resources: [
            {
              uri: 'skill://demo/templates',
              name: 'templates',
              mimeType: DIRECTORY_READ_MIME_TYPE,
            },
          ],
        }
      },
    })

    const resources = await readMcpDirectory(server, 'skill://demo')

    assert.deepEqual(calls, [
      {
        request: {
          method: 'resources/directory/read',
          params: { uri: 'skill://demo' },
        },
        timeout: 30_000,
      },
      {
        request: {
          method: 'resources/directory/read',
          params: { uri: 'skill://demo', cursor: 'cursor-1' },
        },
        timeout: 30_000,
      },
    ])
    assert.deepEqual(resources, [
      { uri: 'skill://demo/a', name: 'a.txt' },
      {
        uri: 'skill://demo/templates',
        name: 'templates',
        mimeType: DIRECTORY_READ_MIME_TYPE,
      },
    ])
  })

  it('stops after at most 20 pages', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const server = connectedServer({
      request: async request => {
        calls.push(request)
        return {
          resources: [
            {
              uri: `skill://demo/page-${calls.length}`,
              name: `page-${calls.length}`,
            },
          ],
          nextCursor: `cursor-${calls.length}`,
        }
      },
    })

    const resources = await readMcpDirectory(server, 'skill://demo')

    assert.equal(calls.length, 20)
    assert.equal(resources.length, 20)
    assert.deepEqual(calls[0], {
      method: 'resources/directory/read',
      params: { uri: 'skill://demo' },
    })
    assert.deepEqual(calls[19], {
      method: 'resources/directory/read',
      params: { uri: 'skill://demo', cursor: 'cursor-19' },
    })
  })

  it('throws first-page InvalidParams for the tool to convert into a not-directory error', async () => {
    const invalidParams = new McpError(ErrorCode.InvalidParams, 'not a directory')
    const server = connectedServer({
      request: async () => {
        throw invalidParams
      },
    })

    await assert.rejects(
      () => readMcpDirectory(server, 'skill://demo/file.md'),
      error => error === invalidParams,
    )
  })

  it('returns prior entries when a later cursor page becomes InvalidParams', async () => {
    const server = connectedServer({
      request: async request => {
        if (request.params?.cursor) {
          throw new McpError(ErrorCode.InvalidParams, 'stale cursor')
        }
        return {
          resources: [{ uri: 'skill://demo/a', name: 'a.txt' }],
          nextCursor: 'stale-cursor',
        }
      },
    })

    assert.deepEqual(await readMcpDirectory(server, 'skill://demo'), [
      { uri: 'skill://demo/a', name: 'a.txt' },
    ])
  })

  it('throws non-InvalidParams errors', async () => {
    const internalError = new McpError(ErrorCode.InternalError, 'server failed')
    const server = connectedServer({
      request: async () => {
        throw internalError
      },
    })

    await assert.rejects(
      () => readMcpDirectory(server, 'skill://demo'),
      error => error === internalError,
    )
  })
})

describe('ReadMcpResourceDirTool', () => {
  it('is read-only, concurrency-safe, deferred, and exposes the official alias', () => {
    assert.equal(ReadMcpResourceDirTool.name, READ_MCP_RESOURCE_DIR_TOOL_NAME)
    assert.deepEqual(ReadMcpResourceDirTool.aliases, ['ReadMcpResourceDir'])
    assert.equal(ReadMcpResourceDirTool.isReadOnly({ server: 'demo', uri: 'x' }), true)
    assert.equal(
      ReadMcpResourceDirTool.isConcurrencySafe({ server: 'demo', uri: 'x' }),
      true,
    )
    assert.equal(ReadMcpResourceDirTool.shouldDefer, true)
  })

  it('allows manifest directories only on the originating server', async () => {
    const rules = createMcpSkillResourceRules('demo', 'skill://demo/SKILL.md', [
      {
        uri: 'skill://demo/templates/invoice.md',
        digest: '0'.repeat(64),
      },
    ])
    const ctx = dirToolContext([connectedServer()], rules)

    assert.equal(
      (
        await ReadMcpResourceDirTool.checkPermissions(
          { server: 'demo', uri: 'skill://demo/templates' },
          ctx,
        )
      ).behavior,
      'allow',
    )
    assert.equal(
      (
        await ReadMcpResourceDirTool.checkPermissions(
          { server: 'demo', uri: 'skill://other/templates' },
          ctx,
        )
      ).behavior,
      'deny',
    )
    assert.equal(
      (
        await ReadMcpResourceDirTool.checkPermissions(
          { server: 'other', uri: 'skill://demo/templates' },
          ctx,
        )
      ).behavior,
      'deny',
    )
  })

  it('does not allow directory reads above the active skill root', async () => {
    let requests = 0
    const server = connectedServer({
      request: async () => {
        requests++
        return { resources: [] }
      },
    })
    const rules = createMcpSkillResourceRules(
      'demo',
      'skill://repo/team/skill/SKILL.md',
      [
        {
          uri: 'skill://repo/team/skill/templates/invoice.md',
          digest: '0'.repeat(64),
        },
      ],
    )
    const input = { server: 'demo', uri: 'skill://repo' }
    const ctx = dirToolContext([server], rules)

    assert.equal(
      (await ReadMcpResourceDirTool.checkPermissions(input, ctx)).behavior,
      'deny',
    )
    await assert.rejects(
      () => callDirTool(input, [server], rules),
      /outside the originating server and active MCP skill manifest/,
    )
    assert.equal(requests, 0)
  })

  it('supports ported domain-native manifest directories without crossing ports', async () => {
    const rules = createMcpSkillResourceRules(
      'demo',
      'https://localhost:3000/SKILL.md',
      [
        {
          uri: 'https://localhost:3000/templates/invoice.md',
          digest: '0'.repeat(64),
        },
      ],
    )
    const ctx = dirToolContext([connectedServer()], rules)

    assert.equal(
      (
        await ReadMcpResourceDirTool.checkPermissions(
          { server: 'demo', uri: 'https://localhost:3000/templates' },
          ctx,
        )
      ).behavior,
      'allow',
    )
    assert.equal(
      (
        await ReadMcpResourceDirTool.checkPermissions(
          { server: 'demo', uri: 'https://localhost:4000/templates' },
          ctx,
        )
      ).behavior,
      'deny',
    )
  })

  it('rejects non-canonical or authority-changing manifest directory URIs', async () => {
    const rules = createMcpSkillResourceRules('demo', 'skill://demo/SKILL.md', [
      {
        uri: 'skill://demo/templates/invoice.md',
        digest: '0'.repeat(64),
      },
    ])
    const ctx = dirToolContext([connectedServer()], rules)

    for (const uri of [
      'skill://demo:8443/templates',
      'skill://user@demo/templates',
      'skill://demo/templates?view=all',
      'skill://demo/templates#section',
      'skill://DEMO/templates',
      'skill://demo/other/../templates',
    ]) {
      const decision = await ReadMcpResourceDirTool.checkPermissions(
        { server: 'demo', uri },
        ctx,
      )
      assert.equal(decision.behavior, 'deny', uri)
    }
  })

  it('exposes only manifest resources and derived directories in skill scope', async () => {
    const server = connectedServer({
      request: async () => ({
        resources: [
          {
            uri: 'skill://demo/templates/invoice.md',
            name: 'UNTRUSTED_INVOICE_NAME',
            mimeType: 'UNTRUSTED_INVOICE_TYPE',
          },
          {
            uri: 'skill://demo/templates/nested',
            name: 'UNTRUSTED_DIRECTORY_NAME',
            mimeType: 'UNTRUSTED_DIRECTORY_TYPE',
          },
        ],
      }),
    })
    const rules = createMcpSkillResourceRules('demo', 'skill://demo/SKILL.md', [
      {
        uri: 'skill://demo/templates/invoice.md',
        digest: '0'.repeat(64),
      },
      {
        uri: 'skill://demo/templates/nested/guide.md',
        digest: '1'.repeat(64),
      },
    ])

    const result = await callDirTool(
      { server: 'demo', uri: 'skill://demo/templates' },
      [server],
      rules,
    )

    assert.deepEqual(result.data, {
      resources: [
        {
          uri: 'skill://demo/templates/invoice.md',
          name: 'invoice.md',
        },
        {
          uri: 'skill://demo/templates/nested',
          name: 'nested',
          mimeType: DIRECTORY_READ_MIME_TYPE,
        },
      ],
    })
  })

  it('rejects unlisted directory children in skill scope', async () => {
    const server = connectedServer({
      request: async () => ({
        resources: [
          {
            uri: 'skill://demo/templates/private.md',
            name: 'UNLISTED_SECRET',
            mimeType: 'text/UNLISTED_SECRET',
          },
        ],
      }),
    })
    const rules = createMcpSkillResourceRules('demo', 'skill://demo/SKILL.md', [
      {
        uri: 'skill://demo/templates/invoice.md',
        digest: '0'.repeat(64),
      },
    ])

    await assert.rejects(
      () =>
        callDirTool(
          { server: 'demo', uri: 'skill://demo/templates' },
          [server],
          rules,
        ),
      /not listed in the active MCP skill manifest/,
    )
  })

  it('rejects incomplete directory listings in skill scope', async () => {
    const server = connectedServer({
      request: async () => ({ resources: [] }),
    })
    const rules = createMcpSkillResourceRules('demo', 'skill://demo/SKILL.md', [
      {
        uri: 'skill://demo/templates/invoice.md',
        digest: '0'.repeat(64),
      },
    ])

    await assert.rejects(
      () =>
        callDirTool(
          { server: 'demo', uri: 'skill://demo/templates' },
          [server],
          rules,
        ),
      /did not return resource listed in the active MCP skill manifest/,
    )
  })

  it('keeps generic directory reads unchanged without an MCP skill scope', async () => {
    const decision = await ReadMcpResourceDirTool.checkPermissions(
      { server: 'demo', uri: 'skill://demo' },
      dirToolContext([connectedServer()]),
    )
    assert.equal(decision.behavior, 'allow')
  })

  it('enforces the manifest scope when call is invoked directly', async () => {
    let requests = 0
    const server = connectedServer({
      request: async () => {
        requests++
        return { resources: [] }
      },
    })
    const rules = createMcpSkillResourceRules('demo', 'skill://demo/SKILL.md', [
      {
        uri: 'skill://demo/templates/invoice.md',
        digest: '0'.repeat(64),
      },
    ])

    await assert.rejects(
      () =>
        callDirTool(
          { server: 'demo', uri: 'skill://other/templates' },
          [server],
          rules,
        ),
      /outside the originating server and active MCP skill manifest/,
    )
    assert.equal(requests, 0)
  })

  it('rejects unknown and disconnected servers', async () => {
    await assert.rejects(
      () => callDirTool({ server: 'missing', uri: 'skill://demo' }, []),
      /Server "missing" not found\. Available servers:/,
    )

    await assert.rejects(
      () =>
        callDirTool(
          { server: 'demo', uri: 'skill://demo' },
          [
            {
              name: 'demo',
              type: 'failed',
              config: { type: 'sdk', name: 'demo', scope: 'local' },
            },
          ],
        ),
      /Server "demo" is not connected/,
    )
  })

  it('rejects a server without resources before making a request', async () => {
    let requests = 0
    const server = connectedServer({
      capabilities: {
        extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
      },
      request: async () => {
        requests++
        return { resources: [] }
      },
    })

    await assert.rejects(
      () => callDirTool({ server: 'demo', uri: 'skill://demo' }, [server]),
      /Server "demo" does not support resources/,
    )
    assert.equal(requests, 0)
  })

  it('returns a data error without making a request when directoryRead is not declared', async () => {
    let requests = 0
    const server = connectedServer({
      capabilities: { resources: {} },
      request: async () => {
        requests++
        return { resources: [] }
      },
    })

    const result = await callDirTool(
      { server: 'demo', uri: 'skill://demo' },
      [server],
    )

    assert.equal(requests, 0)
    assert.deepEqual(result.data, {
      resources: [],
      error: 'Server "demo" does not support directory listing.',
    })
  })

  it('converts first-page InvalidParams into a not-directory data error', async () => {
    const server = connectedServer({
      request: async () => {
        throw new McpError(ErrorCode.InvalidParams, 'not a directory')
      },
    })

    const result = await callDirTool(
      { server: 'demo', uri: 'skill://demo/file.md' },
      [server],
    )

    assert.deepEqual(result.data, {
      resources: [],
      error:
        'Not a directory resource: skill://demo/file.md. If it is a file resource, use ReadMcpResourceTool instead.',
    })
  })

  it('rejects host-owned Codex Apps plugin runtime before generic resource requests', async () => {
    let requests = 0
    const config = markHostOwnedCodexAppsConfig(
      {
        type: 'http',
        url: CODEX_APPS_PLUGIN_RUNTIME_MCP_URL,
        scope: 'local',
      },
      'plugins',
    )
    const server = connectedServer({
      name: 'codex_apps_plugins',
      config,
      request: async () => {
        requests++
        return { resources: [] }
      },
    })

    await assert.rejects(
      () =>
        callDirTool(
          { server: 'codex_apps_plugins', uri: 'skill://demo' },
          [server],
        ),
      /Server "codex_apps_plugins" does not expose generic MCP resources/,
    )
    assert.equal(requests, 0)
  })

  it('sanitizes directory entry fields returned by the MCP server', async () => {
    const server = connectedServer({
      request: async () => ({
        resources: [
          {
            uri: 'skill://demo/unsafe\uE000.md',
            name: 'unsafe\uE000.md',
            mimeType: 'text/\uE000plain',
          },
        ],
      }),
    })

    const result = await callDirTool(
      { server: 'demo', uri: 'skill://demo' },
      [server],
    )

    assert.deepEqual(result.data, {
      resources: [
        {
          uri: 'skill://demo/unsafe.md',
          name: 'unsafe.md',
          mimeType: 'text/plain',
        },
      ],
    })
  })

  it('summarizes directory entries with a slash for inode/directory', () => {
    const block = ReadMcpResourceDirTool.mapToolResultToToolResultBlockParam(
      {
        resources: [
          {
            uri: 'skill://demo/templates',
            name: 'templates',
            mimeType: DIRECTORY_READ_MIME_TYPE,
          },
          { uri: 'skill://demo/readme.md', name: 'readme.md' },
        ],
      },
      'toolu_1',
    )

    assert.equal(block.type, 'tool_result')
    assert.equal(block.tool_use_id, 'toolu_1')
    assert.match(String(block.content), /Directory listing \(2 entries\):/)
    assert.match(String(block.content), /templates\//)
    assert.match(String(block.content), /readme\.md/)
  })

  it('formats an empty directory explicitly', () => {
    const block = ReadMcpResourceDirTool.mapToolResultToToolResultBlockParam(
      { resources: [] },
      'toolu_empty',
    )

    assert.equal(block.type, 'tool_result')
    assert.equal(block.tool_use_id, 'toolu_empty')
    assert.match(String(block.content), /^Directory is empty\./)
  })
})

describe('MCP directory read registration and classification', () => {
  it('is available through generic resource helper registration paths', () => {
    const toolsSource = readFileSync('src/tools.ts', 'utf8')
    const clientSource = readFileSync('src/services/mcp/client.ts', 'utf8')
    const selectorSource = readFileSync(
      'src/components/agents/ToolSelector.tsx',
      'utf8',
    )

    assert.match(toolsSource, /ReadMcpResourceDirTool/)
    assert.match(
      toolsSource,
      /specialTools[\s\S]*ReadMcpResourceDirTool\.name/,
    )
    assert.match(
      clientSource,
      /resourceTools\.push\([\s\S]*ListMcpResourcesTool[\s\S]*ReadMcpResourceTool[\s\S]*ReadMcpResourceDirTool[\s\S]*\)/,
    )
    assert.match(selectorSource, /ReadMcpResourceDirTool\.name/)
  })

  it('is safe in auto mode and counted as a streamlined read tool with ReadMcpResourceTool', () => {
    assert.equal(isAutoModeAllowlistedTool(READ_MCP_RESOURCE_DIR_TOOL_NAME), true)

    const transform = createStreamlinedTransformer()
    const result = transform({
      type: 'assistant',
      session_id: 'session',
      uuid: 'message',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read_resource',
            name: 'ReadMcpResourceTool',
            input: { server: 'demo', uri: 'skill://demo/readme.md' },
          },
          {
            type: 'tool_use',
            id: 'toolu_read_directory',
            name: READ_MCP_RESOURCE_DIR_TOOL_NAME,
            input: { server: 'demo', uri: 'skill://demo' },
          },
        ],
      },
    } as never)

    assert.deepEqual(result, {
      type: 'streamlined_tool_use_summary',
      tool_summary: 'Read 2 files',
      session_id: 'session',
      uuid: 'message',
    })
  })
})
