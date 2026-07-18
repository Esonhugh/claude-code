import { describe, expect, test } from 'bun:test'
import type { Tool } from '../Tool.js'
import { buildCodexAppPluginProjections } from '../services/apps/pluginProjection.js'
import { generateUnifiedSuggestions } from './unifiedSuggestions.js'

function appTool(name: string, connectorId: string, connectorName: string): Tool {
  return {
    name,
    mcpInfo: { serverName: 'codex_apps', toolName: name },
    connectorInfo: {
      id: connectorId,
      name: connectorName,
      description: `Use ${connectorName}`,
    },
  } as Tool
}

describe('Codex App suggestions', () => {
  const apps = buildCodexAppPluginProjections([
    appTool('mcp__codex_apps__github__search', 'github-id', 'GitHub'),
    appTool('mcp__codex_apps__gmail__search', 'gmail-id', 'Gmail'),
  ])

  test('lists discovered apps for a bare @ trigger', async () => {
    const suggestions = await generateUnifiedSuggestions('', {}, [], apps, true)

    expect(suggestions.slice(0, 2)).toEqual([
      expect.objectContaining({
        id: 'codex-app-github',
        displayText: 'codex-app:github',
      }),
      expect.objectContaining({
        id: 'codex-app-gmail',
        displayText: 'codex-app:gmail',
      }),
    ])
  })

  test('lists discovered apps for the dedicated prefix', async () => {
    expect(
      await generateUnifiedSuggestions('codex-app:', {}, [], apps, true),
    ).toEqual([
      expect.objectContaining({
        id: 'codex-app-github',
        displayText: 'codex-app:github',
      }),
      expect.objectContaining({
        id: 'codex-app-gmail',
        displayText: 'codex-app:gmail',
      }),
    ])
  })

  test('filters by app name without returning files or resources', async () => {
    expect(
      await generateUnifiedSuggestions('codex-app:git', {}, [], apps, true),
    ).toEqual([
      expect.objectContaining({
        id: 'codex-app-github',
        displayText: 'codex-app:github',
      }),
    ])
  })
})
