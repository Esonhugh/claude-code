import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getDenyRuleForTool, hasPermissionsToUseTool, toolAlwaysAllowedRule } = await import('./permissions.js')
const { filterToolsByDenyRules } = await import('../../tools.js')

function fakeTool(name: string): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'passthrough', message: `${name} needs approval` }),
  } as unknown as Tool
}

function context(rules: {
  deny?: string[]
  ask?: string[]
  allow?: string[]
  mode?: ToolPermissionContext['mode']
}): ToolUseContext {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      mode: rules.mode ?? 'default',
      alwaysDenyRules: { userSettings: rules.deny ?? [] },
      alwaysAskRules: { userSettings: rules.ask ?? [] },
      alwaysAllowRules: { userSettings: rules.allow ?? [] },
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

const check = (tool: Tool, input: Record<string, unknown>, ctx: ToolUseContext) =>
  hasPermissionsToUseTool(tool, input, ctx, { message: { id: 'msg_test' } } as never, 'toolu_test')

test('a deny Tool(param:value) rule blocks matching input only', async () => {
  const agent = fakeTool('Agent')
  const ctx = context({ deny: ['Agent(model:opus)'], allow: ['Agent'] })
  const denied = await check(agent, { model: 'opus', prompt: 'x' }, ctx)
  expect(denied.behavior).toBe('deny')
  expect(denied).toMatchObject({
    message: 'Permission to use Agent with model:opus has been denied.',
    decisionReason: { type: 'rule', rule: { ruleValue: { toolName: 'Agent', ruleContent: 'model:opus' } } },
  })
  expect((await check(agent, { model: 'sonnet', prompt: 'x' }, ctx)).behavior).toBe('allow')
  expect((await check(agent, { prompt: 'x' }, ctx)).behavior).toBe('allow')
})

test('param values support * wildcards and only compare primitive input values', async () => {
  const agent = fakeTool('Agent')
  const ctx = context({ deny: ['Agent(subagent_type:general-*)'], allow: ['Agent'] })
  expect((await check(agent, { subagent_type: 'general-purpose' }, ctx)).behavior).toBe('deny')
  expect((await check(agent, { subagent_type: 'Explore' }, ctx)).behavior).toBe('allow')
  expect((await check(agent, { subagent_type: { name: 'general-purpose' } }, ctx)).behavior).toBe('allow')
})

test('an ask Tool(param:value) rule prompts even in bypass mode', async () => {
  const agent = fakeTool('Agent')
  const ctx = context({ ask: ['Agent(model:opus)'], mode: 'bypassPermissions' })
  const asked = await check(agent, { model: 'opus' }, ctx)
  expect(asked.behavior).toBe('ask')
  expect(asked.decisionReason).toMatchObject({ type: 'rule', rule: { ruleBehavior: 'ask' } })
  expect((await check(agent, { model: 'haiku' }, ctx)).behavior).toBe('allow')
})

test("param rules never re-match a tool's own rule field", async () => {
  const bash = fakeTool('Bash')
  const ctx = context({ deny: ['Bash(command:rm)', 'Bash(timeout:5)'], allow: ['Bash'] })
  expect((await check(bash, { command: 'rm' }, ctx)).behavior).toBe('allow')
  expect((await check(bash, { command: 'ls', timeout: 5 }, ctx)).behavior).toBe('deny')
})

test('a deny rule with "*" as the tool name denies every tool', async () => {
  const ctx = context({ deny: ['*'] })
  const toolPermissionContext = ctx.getAppState().toolPermissionContext
  for (const name of ['Read', 'Bash', 'mcp__server__tool']) {
    expect(getDenyRuleForTool(toolPermissionContext, fakeTool(name))?.ruleValue.toolName).toBe('*')
  }
  expect(filterToolsByDenyRules([fakeTool('Read'), fakeTool('Edit')], toolPermissionContext)).toEqual([])
  expect((await check(fakeTool('Read'), {}, ctx)).behavior).toBe('deny')
})

test('deny tool-name globs match by pattern; allow rules ignore non-MCP globs', () => {
  const ctx = context({ deny: ['Web*'], allow: ['Note*'] })
  const toolPermissionContext = ctx.getAppState().toolPermissionContext
  expect(getDenyRuleForTool(toolPermissionContext, fakeTool('WebFetch'))).not.toBeNull()
  expect(getDenyRuleForTool(toolPermissionContext, fakeTool('Read'))).toBeNull()
  expect(toolAlwaysAllowedRule(toolPermissionContext, fakeTool('NotebookEdit'))).toBeNull()
})

test('a subagent that cannot prompt is told which agent was denied and why', async () => {
  const tool = fakeTool('Bash')
  const base = context({})
  const state = base.getAppState()
  const headless = {
    ...base,
    getAppState: () => ({
      ...state,
      toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
    }),
  } as ToolUseContext
  const main = await check(tool, {}, headless)
  expect(main).toMatchObject({
    behavior: 'deny',
    decisionReason: { type: 'asyncAgent', reason: 'Permission prompts are not available in this context' },
  })
  expect(main.behavior === 'deny' && main.message).toStartWith('Permission to use Bash has been denied. ')

  const agent = await check(tool, {}, { ...headless, agentId: 'agent-1', agentType: 'general-purpose' } as ToolUseContext)
  expect(agent).toMatchObject({
    behavior: 'deny',
    decisionReason: {
      type: 'asyncAgent',
      reason: 'The general-purpose agent cannot show permission prompts in this session',
    },
  })
  expect(agent.behavior === 'deny' && agent.message).toStartWith(
    'Permission to use Bash has been denied: the general-purpose agent cannot ask for approval because this session has no permission dialog (non-interactive -p or SDK run). ',
  )
})
