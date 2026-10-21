import { expect, test } from 'bun:test'
import type { Tool, ToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getAskRuleForTool, getDenyRuleForTool, toolAlwaysAllowedRule } = await import('./permissions.js')

function rules(behavior: 'allow' | 'deny' | 'ask', ruleStrings: string[]): ToolPermissionContext {
  const initial = getDefaultAppState().toolPermissionContext
  const key = behavior === 'allow' ? 'alwaysAllowRules' : behavior === 'deny' ? 'alwaysDenyRules' : 'alwaysAskRules'
  return { ...initial, [key]: { userSettings: ruleStrings } } as ToolPermissionContext
}

const mcpTool = (serverName: string, toolName: string) =>
  ({ name: `mcp__${serverName}__${toolName}`, mcpInfo: { serverName, toolName } }) as unknown as Tool

const allowed = (rule: string, tool: Tool) => toolAlwaysAllowedRule(rules('allow', [rule]), tool) !== null
const denied = (rule: string, tool: Tool) => getDenyRuleForTool(rules('deny', [rule]), tool) !== null

test('a server allow rule reaches only the server it names', () => {
  expect(allowed('mcp__a', mcpTool('a', 't'))).toBe(true)
  expect(allowed('mcp__a__*', mcpTool('a', 't'))).toBe(true)
  expect(allowed('mcp__a', mcpTool('a__b', 't'))).toBe(false)
  expect(allowed('mcp__a', mcpTool('a_', 't'))).toBe(false)
  expect(allowed('mcp__a__b__*', mcpTool('a__b', 't'))).toBe(true)
})

test('an allow rule for a name that reads as several servers needs the full name', () => {
  const nameOnly = { name: 'mcp__a__b__t' } as unknown as Tool
  expect(allowed('mcp__a', nameOnly)).toBe(false)
  expect(allowed('mcp__a__b__t', nameOnly)).toBe(true)
})

test('allow mcp__* covers every MCP tool and nothing else', () => {
  expect(allowed('mcp__*', mcpTool('x', 't'))).toBe(true)
  expect(allowed('mcp__*', mcpTool('a__b', 't'))).toBe(true)
  expect(allowed('mcp__*', { name: 'Bash' } as unknown as Tool)).toBe(false)
})

test('deny and ask server rules reach a server whose name holds a double underscore', () => {
  expect(denied('mcp__a__b', mcpTool('a__b', 't'))).toBe(true)
  expect(denied('mcp__a', mcpTool('a__b', 't'))).toBe(true)
  expect(denied('mcp__a__b', mcpTool('a', 'b'))).toBe(true)
  expect(denied('mcp__a__b', mcpTool('a__c', 't'))).toBe(false)
  expect(getAskRuleForTool(rules('ask', ['mcp__a__b']), mcpTool('a__b', 't'))).not.toBeNull()
})
