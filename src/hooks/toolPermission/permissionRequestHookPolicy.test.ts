import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { clearRegisteredHooks, registerHookCallbacks, getIsInteractive, setIsInteractive } =
  await import('../../bootstrap/state.js')
const { resetHooksConfigSnapshot } = await import('../../utils/hooks/hooksConfigSnapshot.js')
const { resetSettingsCache, setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { hasPermissionsToUseTool } = await import('../../utils/permissions/permissions.js')
const { applyPermissionUpdate } = await import('../../utils/permissions/PermissionUpdate.js')
const { createPermissionContext } = await import('./PermissionContext.js')

let home: string
let savedHome: string | undefined
let savedConfig: string | undefined
let interactive: boolean
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'permission-request-policy-'))
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

function hookAllows(decision: Record<string, unknown>) {
  registerHookCallbacks({
    PermissionRequest: [{
      hooks: [{
        type: 'callback',
        callback: async () => ({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...decision } },
        }),
      }],
    }],
  })
}

// Stands in for a content deny rule: the tool denies the value "secret".
const guardedTool = {
  name: 'Guarded',
  inputSchema: z.object({ value: z.string() }),
  isReadOnly: () => false,
  checkPermissions: async ({ value }: { value: string }): Promise<PermissionResult> =>
    value === 'secret'
      ? { behavior: 'deny', message: 'Permission to use Guarded with secret has been denied.', decisionReason: { type: 'other', reason: 'deny rule' } }
      : { behavior: 'ask', message: 'Guarded needs approval' },
} as unknown as Tool

function context(permission: Partial<ToolPermissionContext>) {
  const initial = getDefaultAppState()
  let state = {
    ...initial,
    toolPermissionContext: { ...initial.toolPermissionContext, ...permission } as ToolPermissionContext,
  }
  const ctx = {
    getAppState: () => state,
    setAppState: (update: (prev: typeof state) => typeof state) => {
      state = update(state)
    },
    abortController: new AbortController(),
    messages: [],
    options: { isNonInteractiveSession: true, tools: [guardedTool] },
  } as unknown as ToolUseContext
  return { ctx, state: () => state }
}

const assistant = { message: { id: 'msg_test' } } as never

test('a setMode bypassPermissions update is ignored when bypass is unavailable', () => {
  const base = getDefaultAppState().toolPermissionContext
  const off = { ...base, mode: 'default', isBypassPermissionsModeAvailable: false } as ToolPermissionContext
  expect(applyPermissionUpdate(off, { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }).mode).toBe('default')
  const on = { ...off, isBypassPermissionsModeAvailable: true }
  expect(applyPermissionUpdate(on, { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }).mode).toBe('bypassPermissions')
})

test('headless: hook updatedInput is re-checked against deny rules', async () => {
  hookAllows({ updatedInput: { value: 'secret' } })
  const { ctx } = context({ shouldAvoidPermissionPrompts: true })
  const result = await hasPermissionsToUseTool(guardedTool, { value: 'safe' }, ctx, assistant, 'toolu_1')
  expect(result.behavior).toBe('deny')
})

test('headless: hook allow without a rewritten input still allows', async () => {
  hookAllows({})
  const { ctx } = context({ shouldAvoidPermissionPrompts: true })
  const result = await hasPermissionsToUseTool(guardedTool, { value: 'safe' }, ctx, assistant, 'toolu_2')
  expect(result).toMatchObject({ behavior: 'allow', updatedInput: { value: 'safe' } })
})

test('headless: hook setMode bypassPermissions respects disableBypassPermissionsMode', async () => {
  hookAllows({ updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] })
  const { ctx, state } = context({ shouldAvoidPermissionPrompts: true, isBypassPermissionsModeAvailable: false })
  const result = await hasPermissionsToUseTool(guardedTool, { value: 'safe' }, ctx, assistant, 'toolu_3')
  expect(result.behavior).toBe('allow')
  expect(state().toolPermissionContext.mode).toBe('default')
})

test('interactive: hook updatedInput is re-checked against deny rules', async () => {
  hookAllows({ updatedInput: { value: 'secret' } })
  const { ctx } = context({})
  let applied: ToolPermissionContext | undefined
  const permission = createPermissionContext(guardedTool, { value: 'safe' }, ctx, assistant, 'toolu_4', next => {
    applied = next
  })
  const result = await permission.runHooks('default', undefined)
  expect(result?.behavior).toBe('deny')
  expect(applied).toBeUndefined()
})
