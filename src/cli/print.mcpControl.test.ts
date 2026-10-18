import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { Tool } from '../Tool.js'

const childFlag = 'CLAUDE_CODE_PRINT_MCP_CONTROL_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('print-mode MCP control requests (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-mcp-control-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      console.log(`${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless, reconcileMcpServers, handleMcpSetServers } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const { buildMcpToolName } = await import('../services/mcp/mcpStringUtils.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const mcpClient = await import('../services/mcp/client.js')
  const mcpConfig = await import('../services/mcp/config.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')

  type AppState = ReturnType<typeof getDefaultAppState>
  const tool = (name: string) => ({ name }) as unknown as Tool
  const connected = (name: string, config: ScopedMcpServerConfig) => ({
    name, type: 'connected', config, capabilities: {}, cleanup: async () => {},
    client: { setRequestHandler() {}, setNotificationHandler() {} },
  }) as unknown as MCPServerConnection

  test('mcp_set_servers removes tools of servers whose names need normalization', async () => {
    const name = 'my.server'
    const config: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/mcp', scope: 'dynamic' }
    const toolName = buildMcpToolName(name, 'echo')
    expect(toolName).toBe('mcp__my_server__echo')
    let app = { mcp: { tools: [tool(toolName)], clients: [{ type: 'failed', name, config }] } } as unknown as AppState
    const result = await reconcileMcpServers({}, {
      clients: [{ type: 'failed', name, config }], tools: [tool(toolName)], configs: { [name]: config },
    }, f => { app = f(app) })
    expect(result.response.removed).toEqual([name])
    expect(result.newState.tools).toEqual([])
    expect(app.mcp.tools).toEqual([])
    expect(app.mcp.clients).toEqual([])

    const sdkName = 'sdk.server'
    const sdkTool = tool(buildMcpToolName(sdkName, 'echo'))
    const sdk = await handleMcpSetServers({}, {
      configs: { [sdkName]: { type: 'sdk', name: sdkName } },
      clients: [{ type: 'pending', name: sdkName, config: { type: 'sdk', name: sdkName, scope: 'dynamic' } }],
      tools: [sdkTool],
    }, { clients: [], tools: [], configs: {} }, f => { app = f(app) })
    expect(sdk.response.removed).toEqual([sdkName])
    expect(sdk.newSdkState.tools).toEqual([])
  })

  async function runControls(initial: AppState, requests: Record<string, unknown>[]) {
    const store = createStore(initial, onChangeAppState)
    const frames: StdoutMessage[] = []
    const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        frames.push(message)
        if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve()
      }),
    ]
    async function* input() {
      for (const [i, request] of requests.entries()) {
        const id = String(i)
        receipts.set(id, Promise.withResolvers<void>())
        yield JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'
        await receipts.get(id)!.promise
      }
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, userSpecifiedModel: 'claude-sonnet-4-6',
        sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    return { state: store.getState(), responses: frames.flatMap(f => f.type === 'control_response' ? [f.response] : []) }
  }

  test('mcp_reconnect and mcp_toggle use the session config of a dynamic server, not a same-named disk entry', async () => {
    const name = 'shared'
    const sessionConfig: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/session', scope: 'dynamic' }
    const diskConfig: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/disk', scope: 'project' }
    const initial = getDefaultAppState()
    initial.mcp.clients = [connected(name, sessionConfig)]
    const used: ScopedMcpServerConfig[] = []
    const mocks = [
      spyOn(mcpConfig, 'getMcpConfigByName').mockImplementation(n => (n === name ? diskConfig : null)),
      spyOn(mcpConfig, 'setMcpServerEnabled').mockImplementation(() => {}),
      spyOn(mcpClient, 'clearServerCache').mockImplementation(async () => {}),
      spyOn(mcpClient, 'reconnectMcpServerImpl').mockImplementation(async (n, config) => {
        used.push(config)
        return { client: connected(n, config), tools: [], commands: [] }
      }),
    ]
    try {
      const { responses } = await runControls(initial, [
        { subtype: 'mcp_reconnect', serverName: name },
        { subtype: 'mcp_toggle', serverName: name, enabled: false },
        { subtype: 'mcp_toggle', serverName: name, enabled: true },
      ])
      expect(responses.map(r => r.subtype)).toEqual(['success', 'success', 'success'])
      expect(used).toEqual([sessionConfig, sessionConfig])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })

  test('mcp_reconnect of a configured server does not leak it into the dynamic set', async () => {
    const name = 'disk'
    const diskConfig: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/disk', scope: 'project' }
    const toolName = buildMcpToolName(name, 'echo')
    const initial = getDefaultAppState()
    initial.mcp.clients = [connected(name, diskConfig)]
    initial.mcp.tools = [tool(toolName)]
    const mocks = [
      spyOn(mcpConfig, 'getMcpConfigByName').mockImplementation(n => (n === name ? diskConfig : null)),
      spyOn(mcpClient, 'reconnectMcpServerImpl').mockImplementation(async (n, config) => (
        { client: connected(n, config), tools: [tool(toolName)], commands: [] })),
    ]
    try {
      const { state, responses } = await runControls(initial, [
        { subtype: 'mcp_reconnect', serverName: name },
        { subtype: 'mcp_set_servers', servers: {} },
      ])
      expect(responses.map(r => r.subtype)).toEqual(['success', 'success'])
      expect(state.mcp.clients.map(c => c.name)).toEqual([name])
      expect(state.mcp.tools.map(t => t.name)).toEqual([toolName])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })
}
