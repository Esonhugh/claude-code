import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PermissionResult } from './PermissionResult.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { hasPermissionsToUseTool } = await import('./permissions.js')
const { checkModToolPermission, resolveHookPermissionDecision } = await import(
  '../../services/tools/toolHooks.js'
)

function fakeTool(
  name: string,
  readOnly: boolean,
  result: PermissionResult = { behavior: 'passthrough', message: `${name} needs approval` },
): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => readOnly,
    checkPermissions: async () => result,
  } as unknown as Tool
}

function context(
  permission: Partial<ToolPermissionContext> & { allow?: string[] },
): ToolUseContext {
  const initial = getDefaultAppState()
  const { allow, ...rest } = permission
  const state = {
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      mode: 'plan',
      alwaysAllowRules: { userSettings: allow ?? [] },
      ...rest,
    } as ToolPermissionContext,
  }
  return {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    messages: [],
    options: { isNonInteractiveSession: false, tools: [] },
  } as unknown as ToolUseContext
}

const check = (tool: Tool, ctx: ToolUseContext) =>
  hasPermissionsToUseTool(tool, {}, ctx, { message: { id: 'msg_test' } } as never, 'toolu_test')

const editAllowedByRule: PermissionResult = {
  behavior: 'allow',
  updatedInput: {},
  decisionReason: {
    type: 'rule',
    rule: { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Edit', ruleContent: 'src/**' } },
  },
}

test('plan mode ignores a content allow rule for a write', async () => {
  const result = await check(fakeTool('Edit', false, editAllowedByRule), context({ allow: ['Edit(src/**)'] }))
  expect(result.behavior).toBe('ask')
  expect(result).toMatchObject({
    message: 'Cannot call Edit while in plan mode.',
    decisionReason: { type: 'mode', mode: 'plan' },
  })
})

test('plan mode ignores a whole-tool allow rule for a write', async () => {
  const result = await check(fakeTool('mcp__srv__write', false), context({ allow: ['mcp__srv__write'] }))
  expect(result.behavior).toBe('ask')
})

test('plan mode keeps allow rules for read-only calls', async () => {
  expect((await check(fakeTool('mcp__srv__read', true), context({ allow: ['mcp__srv__read'] }))).behavior).toBe('allow')
})

test('plan mode entered from bypass still allows writes', async () => {
  const ctx = context({ allow: ['Edit(src/**)'], isBypassPermissionsModeAvailable: true })
  expect((await check(fakeTool('Edit', false, editAllowedByRule), ctx)).behavior).toBe('allow')
})

test('plan mode keeps non-rule allows such as the session plan file', async () => {
  const planFile = fakeTool('Write', false, {
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'other', reason: 'Plan files for current session are allowed for writing' },
  })
  expect((await check(planFile, context({}))).behavior).toBe('allow')
})

test('a PreToolUse hook allow does not run a write in plan mode', async () => {
  const tool = fakeTool('Edit', false, {
    behavior: 'ask',
    message: 'Claude requested permissions to write to src/x.ts',
  })
  let prompted: PermissionResult | undefined
  const { decision } = await resolveHookPermissionDecision(
    { behavior: 'allow', updatedInput: {} },
    tool,
    {},
    context({}),
    async (_tool, _input, _ctx, _msg, _id, forced) => {
      prompted = forced ?? { behavior: 'ask', message: 'prompted' }
      return { behavior: 'deny', message: 'user rejected', decisionReason: { type: 'other', reason: 'test' } }
    },
    { message: { id: 'msg_test' } } as never,
    'toolu_test',
  )
  expect(prompted).toBeDefined()
  expect(decision.behavior).toBe('deny')
})

test('a PreToolUse hook allow still runs a read-only call in plan mode', async () => {
  const { decision } = await resolveHookPermissionDecision(
    { behavior: 'allow', updatedInput: {} },
    fakeTool('mcp__srv__read', true),
    {},
    context({}),
    async () => ({ behavior: 'deny', message: 'unexpected prompt', decisionReason: { type: 'other', reason: 'test' } }),
    { message: { id: 'msg_test' } } as never,
    'toolu_test',
  )
  expect(decision.behavior).toBe('allow')
})

test('the mods core check holds a rule-allowed write in plan mode', async () => {
  const result = await checkModToolPermission(fakeTool('mcp__srv__write', false), {}, context({ allow: ['mcp__srv__write'] }))
  expect(result.behavior).toBe('ask')
  expect(result.decisionReason).toMatchObject({ type: 'mode', mode: 'plan' })
})

test('a mod tool.check allow does not run a write in plan mode', async () => {
  const { dispatchModEvent } = await import('../../services/mods/dispatch.js')
  const ctx = context({}) as ToolUseContext & { modsSnapshot: unknown }
  ctx.modsSnapshot = {
    release: () => {},
    hasHooks: (event: string) => event === 'tool.check',
    dispatch: (_event: string, input: never, core: never, options: object) =>
      dispatchModEvent({
        event: 'tool.check', input, core, ...options,
        hooks: [{
          plugin: 'approver', tier: 'user',
          registration: { id: 1, event: 'tool.check', hasCatch: false },
          invoke: async () => ({ decision: 'allow' }),
        }],
      } as never),
  }
  let prompted = false
  const { decision } = await resolveHookPermissionDecision(
    undefined,
    fakeTool('mcp__srv__write', false),
    {},
    ctx,
    async () => {
      prompted = true
      return { behavior: 'deny', message: 'user rejected', decisionReason: { type: 'other', reason: 'test' } }
    },
    { message: { id: 'msg_test' } } as never,
    'toolu_test',
  )
  expect(prompted).toBe(true)
  expect(decision.behavior).toBe('deny')
})
