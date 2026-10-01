import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'

const childFlag = 'CLAUDE_CODE_DANGEROUS_REMOVAL_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('dangerous removal permissions (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-dangerous-removal-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=BASH_CLASSIFIER', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { BashTool } = await import('../../tools/BashTool/BashTool.js')
  const { hasPermissionsToUseTool } = await import('./permissions.js')

  function contextForPermissionCheck() {
    const state = getDefaultAppState()
    state.toolPermissionContext = { ...state.toolPermissionContext, mode: 'bypassPermissions' }
    return {
      getAppState: () => state,
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
    } as ToolUseContext
  }

  test('bypass pauses dangerous removal for explicit approval', async () => {
    const context = contextForPermissionCheck()
    const input = { command: 'rm -rf /' }
    const checked = await BashTool.checkPermissions(input, context)
    expect(checked.behavior).toBe('ask')
    const result = await hasPermissionsToUseTool(
      BashTool, input, context, undefined as never, 'dangerous-removal',
    )
    expect(result.behavior).toBe('ask')
    expect('pendingClassifierCheck' in result && result.pendingClassifierCheck).toBeFalsy()
  })

  test('PreToolUse ask preserves the mandatory approval rather than masking it', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const result = await resolveHookPermissionDecision(
      { behavior: 'ask', message: 'Hook review', decisionReason: { type: 'hook', hookName: 'PreToolUse' } },
      BashTool, { command: 'rm -rf /' }, contextForPermissionCheck(),
      async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
      undefined as never, 'hook-ask-removal',
    )
    expect(result.decision.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decision.decisionReason)).toBe(true)
  })

  test('PreToolUse ask checks updated input and refuses it without a prompt channel', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const context = contextForPermissionCheck()
    const state = context.getAppState()
    const result = await resolveHookPermissionDecision(
      { behavior: 'ask', message: 'Hook review', updatedInput: { command: 'rm -rf /' } },
      BashTool, { command: 'rm -rf ./dist' }, {
        ...context,
        getAppState: () => ({
          ...state,
          toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
        }),
      },
      async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
      undefined as never, 'hook-updated-removal',
    )
    expect(result.input).toEqual({ command: 'rm -rf /' })
    expect(result.decision.behavior).toBe('deny')
  })

  test('auto mode also requires manual confirmation for critical removal', async () => {
    const context = contextForPermissionCheck()
    const state = context.getAppState()
    const result = await hasPermissionsToUseTool(BashTool, { command: 'rm -rf /' }, {
      ...context,
      getAppState: () => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }),
    }, undefined as never, 'auto-removal')
    expect(result.behavior).toBe('ask')
    expect('pendingClassifierCheck' in result && result.pendingClassifierCheck).toBeFalsy()
  })

  test('sandbox checks every removal even after an unrelated path requires approval', async () => {
    const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')
    const mocks = [
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true),
      spyOn(SandboxManager, 'isAutoAllowBashIfSandboxedEnabled').mockReturnValue(true),
      spyOn(SandboxManager, 'getFsWriteConfig').mockReturnValue({ allowOnly: [], denyWithinAllow: [] }),
    ]
    try {
      const result = await hasPermissionsToUseTool(
        BashTool, { command: 'touch /outside/file && rm -rf /' }, contextForPermissionCheck(), undefined as never, 'sandbox-compound',
      )
      expect(result.behavior).toBe('ask')
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })

  test('tool.check plugins cannot erase a compound mandatory approval', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const context = contextForPermissionCheck()
    let requested = false
    const result = await resolveHookPermissionDecision(
      undefined, BashTool, { command: 'rm -rf / && touch local-file' },
      {
        ...context,
        modsSnapshot: {
          hasHooks: () => true,
          dispatch: async () => ({ decision: 'allow' }),
        } as unknown as NonNullable<ToolUseContext['modsSnapshot']>,
      },
      async (_tool, _input, _context, _message, _id, forced) => {
        requested = true
        return forced ?? { behavior: 'allow' }
      },
      undefined as never, 'plugin-removal',
    )
    expect(result.decision.behavior).toBe('ask')
    expect(requested).toBe(true)
  })

  test('tool.check cannot turn a headless mandatory refusal into a forced ask', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const context = contextForPermissionCheck()
    const state = context.getAppState()
    const result = await resolveHookPermissionDecision(
      undefined, BashTool, { command: 'rm -rf / | cat' }, {
        ...context,
        getAppState: () => ({
          ...state,
          toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
        }),
        modsSnapshot: {
          hasHooks: () => true,
          dispatch: async () => ({ decision: 'allow' }),
        } as unknown as NonNullable<ToolUseContext['modsSnapshot']>,
      },
      async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
      undefined as never, 'plugin-headless-removal',
    )
    expect(result.decision.behavior).toBe('deny')
  })

  test('preserves critical path coverage, explicit deny, and ordinary removal', async () => {
    for (const command of ['rm -rf /tmp', `rm -rf "${homedir()}"`, 'rm -rf ./out/*', 'rmdir /etc', 'timeout 10 rm -rf /']) {
      const result = await hasPermissionsToUseTool(
        BashTool, { command }, contextForPermissionCheck(), undefined as never, 'critical-path',
      )
      expect(result.behavior).toBe('ask')
    }
    const context = contextForPermissionCheck()
    const state = context.getAppState()
    const denied = await hasPermissionsToUseTool(BashTool, { command: 'rm -rf /' }, {
      ...context,
      getAppState: () => ({
        ...state,
        toolPermissionContext: { ...state.toolPermissionContext, alwaysDenyRules: { session: ['Bash(rm:*)'] } },
      }),
    }, undefined as never, 'denied-removal')
    expect(denied.behavior).toBe('deny')
    for (const mode of ['bypassPermissions', 'acceptEdits'] as const) {
      const result = await hasPermissionsToUseTool(BashTool, { command: 'rm -rf ./dist' }, {
        ...context,
        getAppState: () => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode } }),
      }, undefined as never, 'ordinary-removal')
      expect(result.behavior).toBe('allow')
    }
  })

  test('headless refuses dangerous removal even when a permission hook would approve', async () => {
    const hooks = await import('../hooks.js')
    const runHook = spyOn(hooks, 'executePermissionRequestHooks').mockImplementation(async function* () {
      yield { permissionRequestResult: { behavior: 'allow' as const } }
    })
    const context = contextForPermissionCheck()
    const state = context.getAppState()
    const headless = {
      ...context,
      getAppState: () => ({
        ...state,
        toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
      }),
    }
    try {
      const result = await hasPermissionsToUseTool(
        BashTool, { command: 'rm -rf /' }, headless, undefined as never, 'headless-removal',
      )
      expect(result.behavior).toBe('deny')
      expect(runHook).not.toHaveBeenCalled()
    } finally {
      runHook.mockRestore()
    }
  })

  test('sandbox auto-approval still requires approval for dangerous removal', async () => {
    const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')
    const mocks = [
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true),
      spyOn(SandboxManager, 'isAutoAllowBashIfSandboxedEnabled').mockReturnValue(true),
    ]
    try {
      const result = await hasPermissionsToUseTool(
        BashTool, { command: 'rm -rf /' }, contextForPermissionCheck(), undefined as never, 'sandbox-removal',
      )
      expect(result.behavior).toBe('ask')
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })

  test('allow rules cannot bypass compound critical-path approval', async () => {
    const command = 'rm -rf / && touch local-file'
    const context = contextForPermissionCheck()
    const state = context.getAppState()
    const result = await hasPermissionsToUseTool(BashTool, { command }, {
      ...context,
      getAppState: () => ({
        ...state,
        toolPermissionContext: { ...state.toolPermissionContext, alwaysAllowRules: { session: [`Bash(${command})`] } },
      }),
    }, undefined as never, 'allowed-compound')
    expect(result.behavior).toBe('ask')
  })

  test('bypass preserves mandatory approval inside compound commands', async () => {
    for (const command of ['rm -rf / && touch local-file', 'rm -rf / | cat']) {
      const result = await hasPermissionsToUseTool(
        BashTool, { command }, contextForPermissionCheck(), undefined as never, 'compound-removal',
      )
      expect(result.behavior).toBe('ask')
    }
  })
}
