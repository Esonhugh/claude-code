import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { formatDeferredToolLines, isDeferredTool } from './prompt.js'
import { AskUserQuestionTool } from '../AskUserQuestionTool/AskUserQuestionTool.js'
import { SendMessageTool } from '../SendMessageTool/SendMessageTool.js'
import { createTeammateContext, runWithTeammateContext } from '../../utils/teammateContext.js'

function tools(...names: string[]): Tool[] {
  return names.map(name => ({ name }) as Tool)
}


test('Mods placement overrides MCP/alwaysLoad defaults but cannot defer ToolSearch itself', () => {
  const mcp = { name: 'mcp__corp__lookup', isMcp: true } as Tool
  const eager = { name: 'Read', alwaysLoad: true } as Tool
  expect(isDeferredTool(mcp)).toBe(true)
  expect(isDeferredTool(mcp, false)).toBe(false)
  expect(isDeferredTool(eager)).toBe(false)
  expect(isDeferredTool(eager, true)).toBe(true)
  expect(isDeferredTool({ name: 'ToolSearch' } as Tool, true)).toBe(false)
})

test('official 2.1.311 up-front tools: SendMessage for teammates, AskUserQuestion always', () => {
  const mate = createTeammateContext({ agentId: 'mate1@t', agentName: 'mate1', teamName: 't', planModeRequired: false, parentSessionId: 's', abortController: new AbortController() })
  expect(isDeferredTool(SendMessageTool)).toBe(true)
  expect(runWithTeammateContext(mate, () => isDeferredTool(SendMessageTool))).toBe(false)
  expect(isDeferredTool(AskUserQuestionTool)).toBe(false)
})

describe('formatDeferredToolLines', () => {
  test('keeps small namespaces and non-MCP tools exact', () => {
    expect(
      formatDeferredToolLines(
        tools('TaskOutput', 'mcp__github__issue_read', 'mcp__github__issue_write'),
      ),
    ).toEqual([
      'TaskOutput',
      'mcp__github__issue_read',
      'mcp__github__issue_write',
    ])
  })

  test('groups large MCP namespaces while preserving their tool count', () => {
    expect(
      formatDeferredToolLines(
        tools(
          'mcp__chrome-devtools__click',
          'mcp__chrome-devtools__evaluate_script',
          'mcp__chrome-devtools__navigate_page',
          'mcp__chrome-devtools__take_screenshot',
        ),
      ),
    ).toEqual([
      'mcp__chrome-devtools__* (4 tools; use ToolSearch by capability)',
    ])
  })

  test('sorts exact names and namespace summaries deterministically', () => {
    expect(
      formatDeferredToolLines(
        tools(
          'mcp__zeta__d',
          'mcp__zeta__b',
          'mcp__zeta__a',
          'mcp__zeta__c',
          'Alpha',
        ),
      ),
    ).toEqual([
      'Alpha',
      'mcp__zeta__* (4 tools; use ToolSearch by capability)',
    ])
  })

  test('keeps Codex App connectors in separate namespaces', () => {
    expect(
      formatDeferredToolLines(
        tools(
          'mcp__codex_apps__github__fetch',
          'mcp__codex_apps__github__issues',
          'mcp__codex_apps__github__pull_requests',
          'mcp__codex_apps__github__search',
          'mcp__codex_apps__gmail__draft',
          'mcp__codex_apps__gmail__read',
          'mcp__codex_apps__gmail__search',
          'mcp__codex_apps__gmail__send',
        ),
      ),
    ).toEqual([
      'mcp__codex_apps__github__* (4 tools; use ToolSearch by capability)',
      'mcp__codex_apps__gmail__* (4 tools; use ToolSearch by capability)',
    ])
  })
})
