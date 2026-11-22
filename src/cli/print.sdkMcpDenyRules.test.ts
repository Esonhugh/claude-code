import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../Tool.js'

const childFlag = 'CLAUDE_CODE_SDK_MCP_DENY_RULES_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('disallowedTools hides SDK MCP tools from the turn (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-sdk-mcp-deny-rules-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TEST_FIXTURES_ROOT: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const bootstrap = await import('../bootstrap/state.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const mcpClient = await import('../services/mcp/client.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const engine = await import('../QueryEngine.js')
  const { createAssistantMessage } = await import('../utils/messages.js')

  const calcTool = (toolName: string) => ({
    name: `mcp__calc__${toolName}`, isMcp: true, mcpInfo: { serverName: 'calc', toolName },
    isEnabled: () => true,
  }) as unknown as Tool

  async function calcToolsOffered(disallowedTools: string[]) {
    const state = getDefaultAppState()
    const store = createStore({
      ...state,
      toolPermissionContext: { ...state.toolPermissionContext, alwaysDenyRules: { cliArg: disallowedTools } },
    }, onChangeAppState)
    const offered: string[][] = []
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(mcpClient, 'setupSdkMcpClients').mockResolvedValue({
        clients: [{ name: 'calc', type: 'disabled', config: { type: 'sdk', name: 'calc', scope: 'dynamic' } }],
        tools: [calcTool('add'), calcTool('sub')],
      }),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(engine, 'ask').mockImplementation(async function* (options) {
        offered.push(options.tools.map(tool => tool.name).filter(name => name.startsWith('mcp__')))
        const assistant = createAssistantMessage({ content: 'done' })
        yield { type: 'assistant', message: assistant.message, parent_tool_use_id: null,
          session_id: bootstrap.getSessionId(), uuid: assistant.uuid }
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async () => {}),
    ]
    async function* input() {
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], { calc: { type: 'sdk', name: 'calc' } }, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    return offered
  }

  test('without a deny rule both SDK MCP tools are offered', async () => {
    expect(await calcToolsOffered([])).toEqual([['mcp__calc__add', 'mcp__calc__sub']])
  })

  test('a denied SDK MCP tool is not offered, like 2.1.329', async () => {
    expect(await calcToolsOffered(['mcp__calc__add'])).toEqual([['mcp__calc__sub']])
  })

  test('a denied SDK MCP server takes all of its tools', async () => {
    expect(await calcToolsOffered(['mcp__calc'])).toEqual([[]])
  })
}
