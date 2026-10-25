import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_PERMISSION_MODE_UPDATES_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('setMode from hooks and SDK hosts (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-permission-mode-updates-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path], {
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
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  process.env.NODE_ENV = 'test'
  const { clearRegisteredHooks, registerHookCallbacks, setIsInteractive } = await import('../../bootstrap/state.js')
  const { resetHooksConfigSnapshot } = await import('../../utils/hooks/hooksConfigSnapshot.js')
  const { setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })
  setIsInteractive(false)
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { hasPermissionsToUseTool } = await import('../../utils/permissions/permissions.js')
  const { permissionPromptToolResultToPermissionDecision } = await import(
    '../../utils/permissions/PermissionPromptToolResultSchema.js'
  )
  const { isAutoModeActive, setAutoModeActive } = await import('../../utils/permissions/autoModeState.js')
  const { createPermissionContext } = await import('./PermissionContext.js')

  const tool = {
    name: 'Guarded',
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => false,
    checkPermissions: async (): Promise<PermissionResult> => ({ behavior: 'ask', message: 'Guarded needs approval' }),
  } as unknown as Tool

  function context(permission: Partial<ToolPermissionContext>) {
    const initial = getDefaultAppState()
    let state = {
      ...initial,
      toolPermissionContext: {
        ...initial.toolPermissionContext,
        alwaysAllowRules: { localSettings: ['Bash(python3:*)', 'Read'] },
        ...permission,
      } as ToolPermissionContext,
    }
    const ctx = {
      getAppState: () => state,
      setAppState: (update: (prev: typeof state) => typeof state) => {
        state = update(state)
      },
      abortController: new AbortController(),
      messages: [],
      options: { isNonInteractiveSession: true, tools: [tool] },
    } as unknown as ToolUseContext
    return { ctx, state: () => state.toolPermissionContext }
  }

  const assistant = { message: { id: 'msg_test' } } as never
  const toAuto = [{ type: 'setMode' as const, mode: 'auto' as const, destination: 'session' as const }]

  function expectAutoEntered(next: ToolPermissionContext) {
    expect(next.mode).toBe('auto')
    expect(next.alwaysAllowRules.localSettings).toEqual(['Read'])
    expect(next.strippedDangerousRules).toEqual({ localSettings: ['Bash(python3:*)'] })
    expect(isAutoModeActive()).toBe(true)
  }

  test('headless: a PermissionRequest hook switching to auto strips dangerous rules', async () => {
    setAutoModeActive(false)
    clearRegisteredHooks()
    resetHooksConfigSnapshot()
    registerHookCallbacks({
      PermissionRequest: [{
        hooks: [{
          type: 'callback',
          callback: async () => ({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'allow', updatedPermissions: toAuto },
            },
          }),
        }],
      }],
    })
    const { ctx, state } = context({ shouldAvoidPermissionPrompts: true })
    const result = await hasPermissionsToUseTool(tool, {}, ctx, assistant, 'toolu_headless')
    expect(result.behavior).toBe('allow')
    expectAutoEntered(state())
    clearRegisteredHooks()
  })

  test('interactive: a hook or dialog setMode auto goes through the auto transition', async () => {
    setAutoModeActive(false)
    const { ctx } = context({})
    let applied: ToolPermissionContext | undefined
    const permission = createPermissionContext(tool, {}, ctx, assistant, 'toolu_interactive', next => {
      applied = next
    })
    await permission.persistPermissions(toAuto)
    expectAutoEntered(applied!)
  })

  test('SDK: updatedPermissions setMode auto goes through the auto transition', () => {
    setAutoModeActive(false)
    const { ctx, state } = context({})
    permissionPromptToolResultToPermissionDecision(
      { behavior: 'allow', updatedInput: {}, updatedPermissions: toAuto },
      tool, {}, ctx,
    )
    expectAutoEntered(state())
  })

  test('an unavailable mode falls back to default and leaves auto cleanly', () => {
    setAutoModeActive(true)
    const { ctx, state } = context({
      mode: 'auto',
      alwaysAllowRules: { localSettings: ['Read'] },
      strippedDangerousRules: { localSettings: ['Bash(python3:*)'] },
      isBypassPermissionsModeAvailable: false,
    })
    permissionPromptToolResultToPermissionDecision(
      {
        behavior: 'allow', updatedInput: {},
        updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
      },
      tool, {}, ctx,
    )
    expect(state().mode).toBe('default')
    expect(state().alwaysAllowRules.localSettings).toEqual(['Read', 'Bash(python3:*)'])
    expect(state().strippedDangerousRules).toBeUndefined()
    expect(isAutoModeActive()).toBe(false)
  })
}
