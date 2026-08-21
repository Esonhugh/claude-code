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
})
