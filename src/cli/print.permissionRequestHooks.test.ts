import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../Tool.js'

// Runs in a child process: other src/cli tests replace modules print.ts imports.
const childFlag = 'CLAUDE_CODE_PRINT_PERMISSION_REQUEST_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('PermissionRequest hooks in --print (isolated)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, [childFlag]: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals

  const { clearRegisteredHooks, registerHookCallbacks, getIsInteractive, setIsInteractive } =
    await import('../bootstrap/state.js')
  const { resetHooksConfigSnapshot } = await import('../utils/hooks/hooksConfigSnapshot.js')
  const { resetSettingsCache, setSessionSettingsCache } = await import('../utils/settings/settingsCache.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createCanUseToolWithPermissionPrompt, getCanUseToolFn } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')

  let home: string
  let savedHome: string | undefined
  let savedConfig: string | undefined
  let interactive: boolean
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'print-permission-request-'))
    savedHome = process.env.HOME
    savedConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home
    process.env.CLAUDE_CONFIG_DIR = home
    interactive = getIsInteractive()
    setIsInteractive(false)
    clearRegisteredHooks()
    resetSettingsCache()
    resetHooksConfigSnapshot()
    setSessionSettingsCache({ settings: {}, errors: [] })
  })
  afterEach(() => {
    clearRegisteredHooks()
    resetHooksConfigSnapshot()
    resetSettingsCache()
    setIsInteractive(interactive)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    rmSync(home, { recursive: true, force: true })
  })

  const promptingTool = {
    name: 'NeedsApproval',
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => false,
    checkPermissions: async () => ({ behavior: 'passthrough', message: 'NeedsApproval needs approval' }),
  } as unknown as Tool

  function toolUseContext(): ToolUseContext {
    const state = getDefaultAppState()
    return {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      messages: [],
      options: { isNonInteractiveSession: true, tools: [] },
    } as unknown as ToolUseContext
  }

  function permissionRequestHook(behavior: 'allow' | 'deny') {
    let calls = 0
    registerHookCallbacks({
      PermissionRequest: [{
        hooks: [{
          type: 'callback',
          callback: async () => {
            calls++
            return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, message: 'by hook' } } }
          },
        }],
      }],
    })
    return () => calls
  }

  const assistant = { message: { id: 'msg_test' } } as never

  function denials() {
    const io = new StructuredIO((async function* () {})())
    const emitted: unknown[] = []
    io.outbound.enqueue = message => void emitted.push(message)
    return { emitted, io }
  }

  // Like 2.1.311, a call refused before any prompt is reported as
  // system/permission_denied; a PermissionRequest hook's answer is not.
  test('plain --print reports an unanswered prompt as permission_denied', async () => {
    const d = denials()
    const canUseTool = getCanUseToolFn(undefined, d.io, () => [])
    const decision = await canUseTool(promptingTool, {}, { ...toolUseContext(), agentId: 'a1' } as ToolUseContext, assistant, 'toolu_4')
    expect(d.emitted).toEqual([{
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'NeedsApproval',
      tool_use_id: 'toolu_4',
      agent_id: 'a1',
      decision_reason_type: decision.decisionReason?.type,
      decision_reason: undefined,
      message: "Claude requested permissions to use NeedsApproval, but you haven't granted it yet.",
      uuid: expect.any(String),
      session_id: expect.any(String),
    }])
  })

  test('plain --print does not report a PermissionRequest hook denial', async () => {
    permissionRequestHook('deny')
    const d = denials()
    const decision = await getCanUseToolFn(undefined, d.io, () => [])(promptingTool, {}, toolUseContext(), assistant, 'toolu_5')
    expect(decision.behavior).toBe('deny')
    expect(d.emitted).toEqual([])
  })

  test('plain --print runs PermissionRequest hooks for a prompt', async () => {
    const calls = permissionRequestHook('allow')
    const canUseTool = getCanUseToolFn(undefined, denials().io, () => [])
    const decision = await canUseTool(promptingTool, {}, toolUseContext(), assistant, 'toolu_1')
    expect(calls()).toBe(1)
    expect(decision).toMatchObject({ behavior: 'allow', decisionReason: { type: 'hook', hookName: 'PermissionRequest' } })
  })

  test('plain --print keeps the prompt result when no hook decides', async () => {
    const canUseTool = getCanUseToolFn(undefined, denials().io, () => [])
    expect((await canUseTool(promptingTool, {}, toolUseContext(), assistant, 'toolu_2')).behavior).toBe('ask')
  })

  test('--permission-prompt-tool consults PermissionRequest hooks first', async () => {
    const calls = permissionRequestHook('deny')
    let promptToolCalls = 0
    const promptTool = {
      name: 'mcp__host__approve',
      call: async () => {
        promptToolCalls++
        throw new Error('prompt tool should not run')
      },
    } as never
    const decision = await createCanUseToolWithPermissionPrompt(promptTool)(promptingTool, {}, toolUseContext(), assistant, 'toolu_3')
    expect(calls()).toBe(1)
    expect(promptToolCalls).toBe(0)
    expect(decision).toMatchObject({ behavior: 'deny', message: 'by hook' })
  })
}
