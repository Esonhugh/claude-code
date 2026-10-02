import { expect, spyOn, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

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

  function contextForPermissionCheck(permission: Partial<ToolPermissionContext> = {}) {
    const initialState = getDefaultAppState()
    const state = {
      ...initialState,
      toolPermissionContext: { ...initialState.toolPermissionContext, mode: 'bypassPermissions' as const, ...permission },
    }
    return {
      getAppState: () => state,
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
    } as ToolUseContext
  }

  test('whole-tool Bash ask preserves mandatory approval for home configuration removal', async () => {
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const result = await hasPermissionsToUseTool(
      BashTool, { command: 'rm -rf ~/.codex' },
      contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } }),
      undefined as never, 'whole-tool-ask-removal',
    )
    expect(result.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    expect('pendingClassifierCheck' in result && result.pendingClassifierCheck).toBeFalsy()
  })

  test('tool.check allow cannot approve mandatory removal hidden by whole-tool ask', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const result = await resolveHookPermissionDecision(
      undefined, BashTool, { command: 'rm -rf ~/.codex' }, {
        ...contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } }),
        modsSnapshot: {
          hasHooks: () => true,
          dispatch: async () => ({ decision: 'allow' }),
        } as unknown as NonNullable<ToolUseContext['modsSnapshot']>,
      },
      async (tool, input, context, message, id, forced) =>
        forced ?? hasPermissionsToUseTool(tool, input, context, message, id),
      undefined as never, 'plugin-whole-tool-ask-removal',
    )
    expect(result.decision.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decision.decisionReason)).toBe(true)
  })

  test('PreToolUse allow forwards mandatory approval for updated input to the prompt', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const updatedInput = { command: 'rm -rf ~/.codex' }
    const result = await resolveHookPermissionDecision(
      { behavior: 'allow', updatedInput }, BashTool, { command: 'echo safe' },
      contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } }),
      async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
      undefined as never, 'hook-allow-updated-removal',
    )
    expect(result.input).toEqual(updatedInput)
    expect(result.decision.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decision.decisionReason)).toBe(true)
  })

  test('PreToolUse ask preserves mandatory approval from updated input despite whole-tool ask', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const updatedInput = { command: 'rm -rf ~/.codex && echo done' }
    const result = await resolveHookPermissionDecision(
      { behavior: 'ask', message: 'Hook review', updatedInput }, BashTool, { command: 'echo safe' },
      contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } }),
      async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
      undefined as never, 'hook-ask-whole-tool-updated-removal',
    )
    expect(result.input).toEqual(updatedInput)
    expect(result.decision.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decision.decisionReason)).toBe(true)
    expect('pendingClassifierCheck' in result.decision && result.decision.pendingClassifierCheck).toBeFalsy()
  })

  test('tool.check ask cannot replace mandatory approval on PreToolUse updated input', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const updatedInput = { command: 'rm -rf ~/.codex && echo done' }
    for (const behavior of ['ask', 'allow'] as const) {
      const result = await resolveHookPermissionDecision(
        { behavior, message: 'Hook review', updatedInput }, BashTool, { command: 'echo safe' }, {
          ...contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } }),
          modsSnapshot: {
            hasHooks: () => true,
            dispatch: async () => ({ decision: 'ask', reason: 'Plugin review' }),
          } as unknown as NonNullable<ToolUseContext['modsSnapshot']>,
        },
        async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
        undefined as never, 'plugin-ask-updated-removal',
      )
      expect(result.input).toEqual(updatedInput)
      expect(result.decision.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decision.decisionReason)).toBe(true)
    }
  })

  test('whole-tool ask cannot hide headless mandatory refusals from hooks or plugins', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const input = { command: 'rm -rf ~/.codex' }
    for (const permission of [{ shouldAvoidPermissionPrompts: true }, { mode: 'dontAsk' as const }]) {
      const context = contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] }, ...permission })
      const direct = await hasPermissionsToUseTool(BashTool, input, context, undefined as never, 'whole-tool-headless')
      expect(direct.behavior).toBe('deny')
      for (const behavior of [undefined, 'ask', 'allow'] as const) {
        for (const pluginDecision of [undefined, 'ask', 'allow'] as const) {
          const result = await resolveHookPermissionDecision(
            behavior ? { behavior, message: 'Hook review', updatedInput: input } : undefined,
            BashTool, behavior ? { command: 'echo safe' } : input, {
              ...context,
              modsSnapshot: pluginDecision ? {
                hasHooks: () => true,
                dispatch: async () => ({ decision: pluginDecision }),
              } as unknown as NonNullable<ToolUseContext['modsSnapshot']> : undefined,
            },
            async (tool, args, ctx, message, id, forced) =>
              forced ?? hasPermissionsToUseTool(tool, args, ctx, message, id),
            undefined as never, 'hook-plugin-headless-removal',
          )
          expect(result.input).toEqual(input)
          expect(result.decision.behavior).toBe('deny')
        }
      }
    }
  })

  test('explicit whole-tool and command denies take precedence over whole-tool ask', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    for (const denied of ['Bash', 'Bash(rm:*)']) {
      const context = contextForPermissionCheck({
        alwaysAskRules: { session: ['Bash'] }, alwaysDenyRules: { session: [denied] },
      })
      const input = { command: 'rm -rf ~/.codex' }
      const direct = await hasPermissionsToUseTool(BashTool, input, context, undefined as never, 'whole-tool-ask-deny')
      expect(direct.behavior).toBe('deny')
      for (const behavior of ['ask', 'allow'] as const) {
        const result = await resolveHookPermissionDecision(
          { behavior, message: 'Hook review', updatedInput: input }, BashTool, { command: 'echo safe' }, context,
          async () => { throw new Error('An explicit deny must not request approval') },
          undefined as never, 'hook-whole-tool-ask-deny',
        )
        expect(result.input).toEqual(input)
        expect(result.decision.behavior).toBe('deny')
      }
    }
  })

  test('hook and plugin explicit denies remain final for mandatory removal', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const input = { command: 'rm -rf ~/.codex' }
    const context = contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } })
    const hookDeny = {
      behavior: 'deny' as const, message: 'Hook refused',
      decisionReason: { type: 'hook' as const, hookName: 'PreToolUse' },
    }
    const denied = await resolveHookPermissionDecision(
      hookDeny, BashTool, input, context,
      async () => { throw new Error('An explicit deny must not request approval') },
      undefined as never, 'hook-denied-removal',
    )
    expect(denied.decision).toEqual(hookDeny)
    for (const behavior of [undefined, 'ask', 'allow'] as const) {
      const result = await resolveHookPermissionDecision(
        behavior ? { behavior, message: 'Hook review', updatedInput: input } : undefined,
        BashTool, behavior ? { command: 'echo safe' } : input, {
          ...context,
          modsSnapshot: {
            hasHooks: () => true,
            dispatch: async () => ({ decision: 'deny', reason: 'Plugin refused' }),
          } as unknown as NonNullable<ToolUseContext['modsSnapshot']>,
        },
        async () => { throw new Error('An explicit deny must not request approval') },
        undefined as never, 'plugin-denied-removal',
      )
      expect(result.decision).toMatchObject({ behavior: 'deny', message: 'Plugin refused' })
    }
  })

  test('ordinary whole-tool and hook asks retain their existing semantics', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const input = { command: 'echo safe' }
    const context = contextForPermissionCheck({ alwaysAskRules: { session: ['Bash', 'Bash(echo:*)'] } })
    const direct = await hasPermissionsToUseTool(BashTool, input, context, undefined as never, 'ordinary-whole-tool-ask')
    expect(direct).toMatchObject({
      behavior: 'ask', decisionReason: { type: 'rule', rule: { ruleValue: { toolName: 'Bash' } } },
    })
    expect(direct.decisionReason?.type === 'rule' && direct.decisionReason.rule.ruleValue.ruleContent).toBeUndefined()
    const hookAsk = { behavior: 'ask' as const, message: 'Hook review', updatedInput: input }
    const asked = await resolveHookPermissionDecision(
      hookAsk, BashTool, input, context,
      async (_tool, _input, _context, _message, _id, forced) => forced ?? { behavior: 'allow' },
      undefined as never, 'ordinary-hook-ask',
    )
    expect(asked.decision).toEqual(hookAsk)
    const allowed = await resolveHookPermissionDecision(
      undefined, BashTool, input, {
        ...context,
        modsSnapshot: {
          hasHooks: () => true,
          dispatch: async () => ({ decision: 'allow' }),
        } as unknown as NonNullable<ToolUseContext['modsSnapshot']>,
      },
      async () => { throw new Error('Ordinary user rules remain plugin-overridable') },
      undefined as never, 'ordinary-plugin-allow',
    )
    expect(allowed.decision.behavior).toBe('allow')
  })

  test('whole-tool ask keeps sandbox auto-allow only for eligible ordinary commands', async () => {
    const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')
    const mocks = [
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true),
      spyOn(SandboxManager, 'isAutoAllowBashIfSandboxedEnabled').mockReturnValue(true),
      spyOn(SandboxManager, 'areUnsandboxedCommandsAllowed').mockReturnValue(true),
    ]
    const context = contextForPermissionCheck({ alwaysAskRules: { session: ['Bash'] } })
    try {
      for (const input of [{ command: 'echo safe' }, { command: 'echo safe', dangerouslyDisableSandbox: true }, { command: 'rm -rf ~/.codex' }]) {
        const expected = input.dangerouslyDisableSandbox || input.command.startsWith('rm') ? 'ask' : 'allow'
        const direct = await hasPermissionsToUseTool(BashTool, input, context, undefined as never, 'whole-tool-sandbox')
        const hooked = await resolveHookPermissionDecision(
          { behavior: 'allow' }, BashTool, input, context,
          async (tool, args, ctx, message, id, forced) => forced ?? hasPermissionsToUseTool(tool, args, ctx, message, id),
          undefined as never, 'hook-whole-tool-sandbox',
        )
        for (const decision of [direct, hooked.decision]) {
          expect(decision.behavior).toBe(expected)
          expect(requiresExplicitUserApproval(decision.decisionReason)).toBe(input.command.startsWith('rm'))
        }
      }
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
  })

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

  test('bypass requires explicit approval for home configuration directories and their contents', async () => {
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    for (const target of ['~/.config', '~/.codex', '~/.config/app/settings.json', '~/.codex/config.toml']) {
      const result = await hasPermissionsToUseTool(
        BashTool, { command: `rm -rf ${target}` }, contextForPermissionCheck(), undefined as never, 'home-config-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    }
  })

  test('shell startup files and backups remain intact while bypass waits for approval', async () => {
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    const bashrc = join(homedir(), '.bashrc')
    const backup = `${bashrc}.bak`
    const contents = '# isolated deletion test fixture\n'
    writeFileSync(bashrc, contents, { flag: 'wx' })
    copyFileSync(bashrc, backup)
    for (const target of ['~/.bashrc', '~/.bashrc.bak', '~/.zshrc', '~/.zshrc.bak', JSON.stringify(backup)]) {
      const context = contextForPermissionCheck()
      const input = { command: `rm -rf ${target}` }
      const result = await hasPermissionsToUseTool(
        BashTool, input, context, undefined as never, 'shell-config-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
      expect('pendingClassifierCheck' in result && result.pendingClassifierCheck).toBeFalsy()
      const state = context.getAppState()
      const headless = await hasPermissionsToUseTool(BashTool, input, {
        ...context,
        getAppState: () => ({
          ...state,
          toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
        }),
      }, undefined as never, 'headless-shell-config-removal')
      expect(headless.behavior).toBe('deny')
    }
    expect(readFileSync(bashrc, 'utf8')).toBe(contents)
    expect(readFileSync(backup, 'utf8')).toBe(contents)
  })

  test('home configuration protection matches directory boundaries and normalized paths', async () => {
    const { requiresExplicitUserApproval } = await import('./PermissionResult.js')
    for (const target of ['~/.CONFIG', '~/.Codex/config.toml', '~/.BASHRC.BAK', '~/.config/../.codex/config.toml']) {
      const result = await hasPermissionsToUseTool(
        BashTool, { command: `rm -rf ${target}` }, contextForPermissionCheck(), undefined as never, 'normalized-config-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    }
    for (const target of ['~/.configuration', '~/.codex-cache', '~/.bashrc.notes', './fixtures/.bashrc.bak']) {
      const result = await hasPermissionsToUseTool(
        BashTool, { command: `rm -rf ${target}` }, contextForPermissionCheck(), undefined as never, 'ordinary-config-name',
      )
      expect(result.behavior).toBe('allow')
    }
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
