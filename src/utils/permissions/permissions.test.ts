import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getAskRuleForTool, getDenyRuleForTool, hasPermissionsToUseTool, toolAlwaysAllowedRule } = await import('./permissions.js')
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

function mcpTool(serverName: string, toolName: string): Tool {
  return {
    ...fakeTool(`mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__${toolName}`),
    mcpInfo: { serverName, toolName },
  } as Tool
}

test('an MCP server-level allow rule reaches only the server it names', () => {
  const allowed = (rule: string, tool: Tool) =>
    toolAlwaysAllowedRule(context({ allow: [rule] }).getAppState().toolPermissionContext, tool) !== null
  expect(allowed('mcp__a', mcpTool('a', 'run'))).toBe(true)
  expect(allowed('mcp__a__*', mcpTool('a', 'run'))).toBe(true)
  expect(allowed('mcp__a', mcpTool('a__b', 'run'))).toBe(false)
  expect(allowed('mcp__a__*', mcpTool('a__b', 'run'))).toBe(false)
  expect(allowed('mcp__a', mcpTool('a_', 'run'))).toBe(false)
  expect(allowed('mcp__a__b__*', mcpTool('a__b', 'run'))).toBe(true)
  expect(allowed('mcp__a__b__run', mcpTool('a__b', 'run'))).toBe(true)
  expect(allowed('mcp__a___*', mcpTool('a_', 'run'))).toBe(true)
  expect(allowed('mcp__a__r*', mcpTool('a', 'run'))).toBe(true)
  expect(allowed('mcp__a__r*', mcpTool('a', 'list'))).toBe(false)
  // Like official, a server whose name holds "__" is allowed only as "mcp__<server>__*";
  // "mcp__a__b" reads as tool b of server a. Allow takes no "mcp__*" either.
  expect(allowed('mcp__a__b', mcpTool('a__b', 'run'))).toBe(false)
  expect(allowed('mcp__*', mcpTool('a', 'run'))).toBe(false)
  // A bare name that reads as more than one server is not allowed by the shorter one.
  expect(allowed('mcp__a', fakeTool('mcp__a__b__run'))).toBe(false)
  expect(allowed('mcp__a', fakeTool('mcp__a__run'))).toBe(true)
})

test('MCP server-level deny and ask rules reach servers whose name contains __', () => {
  const ctx = context({ deny: ['mcp__a__b'], ask: ['mcp__c__d__*'] }).getAppState().toolPermissionContext
  expect(getDenyRuleForTool(ctx, mcpTool('a__b', 'run'))).not.toBeNull()
  expect(getAskRuleForTool(ctx, mcpTool('c__d', 'run'))).not.toBeNull()
  expect(getDenyRuleForTool(ctx, mcpTool('a', 'run'))).toBeNull()
  // Deny stays broad: the first segment of the server name still matches.
  const broad = context({ deny: ['mcp__a'] }).getAppState().toolPermissionContext
  expect(getDenyRuleForTool(broad, mcpTool('a', 'run'))).not.toBeNull()
  expect(getDenyRuleForTool(broad, mcpTool('a__b', 'run'))).not.toBeNull()
  expect(getDenyRuleForTool(broad, mcpTool('ab', 'run'))).toBeNull()
})

test('MCP servers named constructor or toString follow rules and modes like any other', async () => {
  for (const server of ['constructor', 'toString']) {
    const tool = mcpTool(server, 'run')
    expect((await check(tool, {}, context({ mode: 'bypassPermissions' }))).behavior).toBe('allow')
    expect((await check(tool, {}, context({}))).behavior).toBe('ask')
    expect((await check(tool, {}, context({ allow: [`mcp__${server}`] }))).behavior).toBe('allow')
    expect((await check(tool, {}, context({ allow: [`mcp__${server}`], deny: [`mcp__${server}__*`] }))).behavior).toBe(
      'deny',
    )
  }
})
