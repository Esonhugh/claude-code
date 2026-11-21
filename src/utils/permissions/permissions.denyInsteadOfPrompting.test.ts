import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PermissionResult } from './PermissionResult.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getIsInteractive, setIsInteractive } = await import('../../bootstrap/state.js')
const { resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } = await import(
  '../settings/settingsCache.js'
)
const { applySettingsChange } = await import('../settings/applySettingsChange.js')
const { hasPermissionsToUseTool } = await import('./permissions.js')
const { initializeToolPermissionContext } = await import('./permissionSetup.js')
const { modToolCheckResult, resolveHookPermissionDecision, setModToolCheckPermissionHost } = await import(
  '../../services/tools/toolHooks.js'
)

afterEach(() => resetSettingsCache())

const NO_APPROVAL_SURFACE =
  'Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically. The action was NOT performed; do not claim it succeeded, and do not retry it: this action, and anything else that requires approval, will be denied the same way for the rest of this session. Tell the user what was blocked and why you needed it, then continue with the parts of the task that do not require approval. What required approval: '

function fakeTool(result: PermissionResult = { behavior: 'passthrough', message: 'NeedsApproval needs approval' }): Tool {
  return {
    name: 'NeedsApproval',
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => false,
    checkPermissions: async () => result,
  } as unknown as Tool
}

async function check(
  permission: Partial<ToolPermissionContext>,
  tool = fakeTool(),
  agentType?: string,
): Promise<{ behavior: string; message?: string; decisionReason?: unknown }> {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: { ...initial.toolPermissionContext, mode: 'default', ...permission } as ToolPermissionContext,
  }
  const context = {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    messages: [],
    options: { isNonInteractiveSession: false, tools: [] },
    ...(agentType ? { agentId: 'agent_test', agentType } : {}),
  } as unknown as ToolUseContext
  return hasPermissionsToUseTool(tool, {}, context, { message: { id: 'msg_test' } } as never, 'toolu_test')
}

test('denyInsteadOfPrompting denies a call that would prompt, with the no approval surface message of 2.1.329', async () => {
  for (const agentType of [undefined, 'general-purpose']) {
    for (const shouldAvoidPermissionPrompts of [undefined, true]) {
      const decision = await check({ denyInsteadOfPrompting: true, shouldAvoidPermissionPrompts }, fakeTool(), agentType)
      expect(decision).toMatchObject({
        behavior: 'deny',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'no approval surface in this session; permission request denied automatically',
        },
      })
      expect(decision.message).toStartWith(NO_APPROVAL_SURFACE)
    }
  }
})

test('denyInsteadOfPrompting also denies an ask that needs a person, such as a safety check', async () => {
  const safetyCheck = fakeTool({
    behavior: 'ask',
    message: 'Editing .git needs approval',
    decisionReason: { type: 'safetyCheck', reason: 'protected path', classifierApprovable: false },
  })
  expect((await check({}, safetyCheck)).behavior).toBe('ask')
  const decision = await check({ denyInsteadOfPrompting: true, mode: 'acceptEdits' }, safetyCheck)
  expect(decision.behavior).toBe('deny')
  expect(decision.message).toBe(`${NO_APPROVAL_SURFACE}Editing .git needs approval`)
})

test('allow rules and the permission mode decide before denyInsteadOfPrompting, and without it the call still prompts', async () => {
  const on = { denyInsteadOfPrompting: true }
  expect((await check({ ...on, alwaysAllowRules: { userSettings: ['NeedsApproval'] } })).behavior).toBe('allow')
  expect((await check({ ...on, mode: 'bypassPermissions' })).behavior).toBe('allow')
  expect((await check({ ...on, mode: 'dontAsk' })).message).toContain("don't ask mode")
  expect((await check({})).behavior).toBe('ask')
})

const init = async () =>
  (
    await initializeToolPermissionContext({
      allowedToolsCli: [],
      disallowedToolsCli: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      addDirs: [],
    })
  ).toolPermissionContext
const setting = { permissions: { denyInsteadOfPrompting: true } }

test('denyInsteadOfPrompting is read from user, --settings and managed settings; project and local settings are ignored', async () => {
  for (const source of ['projectSettings', 'localSettings'] as const) {
    resetSettingsCache()
    setCachedSettingsForSource(source, setting)
    expect((await init()).denyInsteadOfPrompting ?? false).toBe(false)
  }
  for (const source of ['userSettings', 'flagSettings', 'policySettings'] as const) {
    resetSettingsCache()
    setCachedSettingsForSource(source, setting)
    expect((await init()).denyInsteadOfPrompting).toBe(true)
  }
})

test('a settings change turns denyInsteadOfPrompting on and off mid-session, and keeps --permission-prompts none', async () => {
  let state = getDefaultAppState()
  const setAppState = (f: (prev: typeof state) => typeof state) => {
    state = f(state)
  }
  setCachedSettingsForSource('userSettings', setting)
  applySettingsChange('userSettings', setAppState)
  expect(state.toolPermissionContext.denyInsteadOfPrompting).toBe(true)
  resetSettingsCache()
  setCachedSettingsForSource('userSettings', {})
  applySettingsChange('userSettings', setAppState)
  expect(state.toolPermissionContext.denyInsteadOfPrompting).toBe(false)

  // What --permission-prompts none puts in the print-mode AppState.
  state = {
    ...state,
    toolPermissionContext: {
      ...state.toolPermissionContext,
      shouldAvoidPermissionPrompts: true,
      denyInsteadOfPrompting: true,
    },
  }
  applySettingsChange('userSettings', setAppState)
  expect(state.toolPermissionContext.denyInsteadOfPrompting).toBe(true)
})

test("denyInsteadOfPrompting does not offer Claude's questions or plan mode's tools to the model", async () => {
  const { AskUserQuestionTool } = await import('../../tools/AskUserQuestionTool/AskUserQuestionTool.js')
  const { EnterPlanModeTool } = await import('../../tools/EnterPlanModeTool/EnterPlanModeTool.js')
  const { ExitPlanModeV2Tool } = await import('../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js')
  const offered = () => [AskUserQuestionTool, EnterPlanModeTool, ExitPlanModeV2Tool].map(tool => tool.isEnabled())
  const withSettings = (source: 'userSettings' | 'projectSettings', settings: Record<string, unknown>) => {
    resetSettingsCache()
    setSessionSettingsCache({ settings: { planModeAvailable: true }, errors: [] })
    setCachedSettingsForSource(source, settings)
  }
  const wasInteractive = getIsInteractive()
  setIsInteractive(true)
  try {
    withSettings('userSettings', {})
    expect(offered()).toEqual([true, true, true])
    withSettings('projectSettings', setting)
    expect(offered()).toEqual([true, true, true])
    withSettings('userSettings', setting)
    expect(offered()).toEqual([false, false, false])
  } finally {
    setIsInteractive(wasInteractive)
  }
})

test('a mod is not told a host decides an ask that denyInsteadOfPrompting will deny', () => {
  const ask = { behavior: 'ask', message: 'needs approval' } as const
  setModToolCheckPermissionHost(true)
  try {
    expect(modToolCheckResult(ask, undefined, { mode: 'default' }).decider).toBe('host')
    expect(modToolCheckResult(ask, undefined, { mode: 'default', denyInsteadOfPrompting: true }).decider).toBeUndefined()
  } finally {
    setModToolCheckPermissionHost(false)
  }
})

test('a PreToolUse hook ask is denied as well, where it used to keep its dialog', async () => {
  const resolve = async (permission: Partial<ToolPermissionContext>) => {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: { ...initial.toolPermissionContext, mode: 'default', ...permission } as ToolPermissionContext,
    }
    let prompted = false
    const { decision } = await resolveHookPermissionDecision(
      { behavior: 'ask', message: 'hook-ask' },
      fakeTool(),
      {},
      {
        getAppState: () => state,
        setAppState: () => {},
        abortController: new AbortController(),
        messages: [],
        options: { isNonInteractiveSession: false, tools: [] },
      } as unknown as ToolUseContext,
      async (_tool, _input, _context, _message, _id, forced) => {
        prompted = true
        return forced ?? { behavior: 'ask', message: 'unforced' }
      },
      { message: { id: 'msg_test' } } as never,
      'toolu_test',
    )
    return { decision: decision as { behavior: string; message?: string }, prompted }
  }
  expect(await resolve({})).toMatchObject({ decision: { behavior: 'ask', message: 'hook-ask' }, prompted: true })
  for (const permission of [
    { denyInsteadOfPrompting: true },
    { denyInsteadOfPrompting: true, shouldAvoidPermissionPrompts: true },
    { denyInsteadOfPrompting: true, alwaysAllowRules: { userSettings: ['NeedsApproval'] } },
  ]) {
    expect(await resolve(permission)).toEqual({
      decision: expect.objectContaining({ behavior: 'deny', message: `${NO_APPROVAL_SURFACE}hook-ask` }),
      prompted: false,
    })
  }
})

test('a tool.check mod cannot allow a managed PreToolUse ask that denyInsteadOfPrompting denies', async () => {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      mode: 'default',
      denyInsteadOfPrompting: true,
    } as ToolPermissionContext,
  }
  const resolve = async (hookSource: string) => {
    const { decision } = await resolveHookPermissionDecision(
      {
        behavior: 'ask',
        message: 'hook-ask',
        decisionReason: { type: 'hook', hookName: 'PreToolUse:NeedsApproval', hookSource, reason: 'hook-ask' },
      },
      fakeTool(),
      {},
      {
        getAppState: () => state,
        setAppState: () => {},
        abortController: new AbortController(),
        messages: [],
        options: { isNonInteractiveSession: false, tools: [] },
        modsSnapshot: {
          hasHooks: () => true,
          dispatch: async (
            _event: string,
            _input: unknown,
            _core: unknown,
            options: { onHooks?: (hooks: { plugin: string }[]) => void },
          ) => {
            options.onHooks?.([{ plugin: 'lifter' }])
            return { decision: 'allow' }
          },
        },
      } as unknown as ToolUseContext,
      async () => ({ behavior: 'ask', message: 'prompted' }),
      { message: { id: 'msg_test' } } as never,
      'toolu_test',
    )
    return decision as { behavior: string; message?: string }
  }
  expect((await resolve('userSettings')).behavior).toBe('allow')
  expect(await resolve('policySettings')).toMatchObject({ behavior: 'deny', message: `${NO_APPROVAL_SURFACE}hook-ask` })
})
