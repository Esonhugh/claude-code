import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { filterEnabledCodexAppTools } from './preferences.js'

function tool(
  name: string,
  serverName: string,
  connectorId?: string,
): Tool {
  return {
    name,
    mcpInfo: { serverName, toolName: name },
    ...(connectorId && { connectorInfo: { id: connectorId } }),
  } as Tool
}

describe('filterEnabledCodexAppTools', () => {
  test('filters only tools belonging to disabled Codex App connectors', () => {
    const github = tool('github_search', 'codex_apps', 'connector_github')
    const gmail = tool('gmail_search', 'codex_apps', 'connector_gmail')
    const ordinary = tool('ordinary_search', 'other', 'connector_github')

    expect(
      filterEnabledCodexAppTools(
        [github, gmail, ordinary],
        new Set(['connector_github']),
      ),
    ).toEqual([gmail, ordinary])
  })

  test('keeps host tools without connector identity', () => {
    const unknown = tool('unknown', 'codex_apps')
    expect(
      filterEnabledCodexAppTools([unknown], new Set(['connector_unknown'])),
    ).toEqual([unknown])
  })
})
