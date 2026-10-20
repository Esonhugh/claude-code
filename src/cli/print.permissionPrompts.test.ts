import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_PERMISSION_PROMPTS_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('--permission-prompts none denies locally in a real headless session (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-permission-prompts-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
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
  const { z } = await import('zod/v4')
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const engine = await import('../QueryEngine.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const { createAssistantMessage } = await import('../utils/messages.js')

  const promptingTool = {
    name: 'NeedsApproval',
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'passthrough', message: 'NeedsApproval needs approval' }),
  } as unknown as import('../Tool.js').Tool

  async function runOnce(permissionPrompts: 'host' | 'none' | undefined) {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const decisions: { behavior: string; avoidPrompts: boolean | undefined }[] = []
    let shutdownCode: number | undefined
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(code => { shutdownCode ??= code }),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(process.stderr, 'write').mockImplementation(() => true),
      spyOn(engine, 'ask').mockImplementation(async function* (options) {
        const toolUseContext = {
          getAppState: options.getAppState,
          setAppState: () => {},
          abortController: new AbortController(),
          messages: [],
          options: { isNonInteractiveSession: true, tools: [] },
        } as unknown as import('../Tool.js').ToolUseContext
        try {
          const decision = await options.canUseTool(promptingTool, {}, toolUseContext, { message: { id: 'msg_test' } } as never, 'toolu_test')
          decisions.push({ behavior: decision.behavior, avoidPrompts: options.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts })
        } catch {
          decisions.push({ behavior: 'error', avoidPrompts: options.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts })
        }
        const assistant = createAssistantMessage({ content: 'done' })
        yield { type: 'assistant', message: assistant.message, parent_tool_use_id: null, session_id: 'session', uuid: assistant.uuid }
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async () => {}),
    ]
    async function* input() {
      yield JSON.stringify({ type: 'user', message: { role: 'user', content: 'run the tool' } }) + '\n'
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, userSpecifiedModel: 'claude-sonnet-4-6',
        permissionPromptToolName: 'mcp__host__approve', permissionPrompts,
        sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    return { decisions, shutdownCode }
  }

  test('none answers prompts with a local deny instead of the --permission-prompt-tool', async () => {
    const { decisions } = await runOnce('none')
    expect(decisions).toEqual([{ behavior: 'deny', avoidPrompts: true }])
  })

  test('host (the default) still routes prompts to the --permission-prompt-tool', async () => {
    const { decisions, shutdownCode } = await runOnce(undefined)
    expect(decisions).toEqual([{ behavior: 'error', avoidPrompts: undefined }])
    expect(shutdownCode).toBe(1)
  })
}
