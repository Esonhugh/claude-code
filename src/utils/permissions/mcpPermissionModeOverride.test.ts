import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { hasPermissionsToUseTool } = await import('./permissions.js')
const { parseMcpPermissionModeOverride } = await import('./mcpPermissionModeOverride.js')

function tool(name: string, serverName?: string): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'passthrough', message: `${name} needs approval` }),
    ...(serverName && { mcpInfo: { serverName, toolName: 'run' } }),
  } as unknown as Tool
}

function context(
  mode: ToolPermissionContext['mode'],
  mcpPermissionModeOverrides: Record<string, 'default' | 'auto'>,
): ToolUseContext {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: { ...initial.toolPermissionContext, mode, mcpPermissionModeOverrides },
  }
  return {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    messages: [],
    options: { isNonInteractiveSession: false, tools: [] },
  } as unknown as ToolUseContext
}

const check = (t: Tool, ctx: ToolUseContext) =>
  hasPermissionsToUseTool(t, {}, ctx, { message: { id: 'msg_test' } } as never, 'toolu_test')

test('a server pinned to default asks for its tools in bypass mode; other tools still run', async () => {
  const ctx = context('bypassPermissions', { pinned: 'default' })
  expect((await check(tool('mcp__pinned__run', 'pinned'), ctx)).behavior).toBe('ask')
  expect((await check(tool('mcp__other__run', 'other'), ctx)).behavior).toBe('allow')
  expect((await check(tool('Read'), ctx)).behavior).toBe('allow')
  // The pin only tightens: it does not change default or dontAsk sessions.
  expect((await check(tool('mcp__pinned__run', 'pinned'), context('dontAsk', { pinned: 'default' }))).behavior).toBe('deny')
  // A server name that matches an Object prototype key is not pinned.
  expect((await check(tool('mcp__toString__run', 'toString'), context('bypassPermissions', {}))).behavior).toBe('allow')
})

test('set_mcp_permission_mode_override accepts only default, auto or null', () => {
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'default' })).toEqual({ serverName: 's', override: 'default' })
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'auto' })).toEqual({ serverName: 's', override: 'auto' })
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: null })).toEqual({ serverName: 's', override: undefined })
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'bypassPermissions' })).toEqual({
    error: "Permission mode override over the control channel is tighten-only ('default', 'auto', or null); rejected 'bypassPermissions'",
  })
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'nope' })).toMatchObject({ error: expect.stringMatching(/^Cannot set permission mode: must be one of /) })
  expect(parseMcpPermissionModeOverride({ mode: 'default' })).toEqual({ error: 'set_mcp_permission_mode_override: serverName must be a string' })
})

test('set_mcp_permission_mode_override validates askForTools like official', () => {
  const askError = {
    error: 'set_mcp_permission_mode_override: askForTools must be a list of at most 32 {name} entries, each name 1 to 64 letters, digits, underscores or hyphens',
  }
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'default', askForTools: [{ name: 'navigate' }] })).toEqual({ serverName: 's', override: 'default' })
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: null, askForTools: null })).toEqual({ serverName: 's', override: undefined })
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'default', askForTools: [{ name: 'a b' }] })).toEqual(askError)
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'default', askForTools: ['navigate'] })).toEqual(askError)
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'default', askForTools: Array.from({ length: 33 }, () => ({ name: 'x' })) })).toEqual(askError)
  // The mode is checked first.
  expect(parseMcpPermissionModeOverride({ serverName: 's', mode: 'plan', askForTools: 'x' })).toMatchObject({ error: expect.stringMatching(/tighten-only/) })
})
