import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { formatDeferredToolLines } from './prompt.js'

function tools(...names: string[]): Tool[] {
  return names.map(name => ({ name }) as Tool)
}

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
