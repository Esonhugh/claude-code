import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import {
  buildCodexAppPluginProjections,
  extractCodexAppMentions,
  resolveCodexAppMentions,
} from './pluginProjection.js'

function appTool({
  name,
  connectorId,
  connectorName,
  description,
  serverName = 'codex_apps',
}: {
  name: string
  connectorId?: string
  connectorName?: string
  description?: string
  serverName?: string
}): Tool {
  return {
    name,
    mcpInfo: { serverName, toolName: name },
    connectorInfo: {
      id: connectorId,
      name: connectorName,
      description,
    },
  } as Tool
}

describe('buildCodexAppPluginProjections', () => {
  test('groups trusted tools by connector and creates stable plugin-like identities', () => {
    const projections = buildCodexAppPluginProjections([
      appTool({
        name: 'mcp__codex_apps__github__search',
        connectorId: 'connector_github',
        connectorName: 'GitHub',
        description: 'Work with repositories',
      }),
      appTool({
        name: 'mcp__codex_apps__github__fetch',
        connectorId: 'connector_github',
        connectorName: 'GitHub',
      }),
      appTool({
        name: 'mcp__codex_apps__gmail__search',
        connectorId: 'connector_gmail',
        connectorName: 'Gmail',
      }),
    ])

    expect(projections).toHaveLength(2)
    expect(projections[0]).toMatchObject({
      kind: 'connector-projection',
      connectorId: 'connector_github',
      connectorName: 'GitHub',
      displayName: 'GitHub',
      marketplace: 'chatgpt-connectors',
      status: 'available',
      description: 'Work with repositories',
    })
    expect(projections[0]!.pluginId).toMatch(
      /^codex-app-github-[a-f0-9]{8}@chatgpt-connectors$/,
    )
    expect(projections[0]!.toolNames).toEqual([
      'mcp__codex_apps__github__fetch',
      'mcp__codex_apps__github__search',
    ])
  })

  test('ignores ordinary MCP tools and connector metadata without an id', () => {
    expect(
      buildCodexAppPluginProjections([
        appTool({
          name: 'mcp__other__github_search',
          connectorId: 'connector_github',
          connectorName: 'GitHub',
          serverName: 'other',
        }),
        appTool({
          name: 'mcp__codex_apps__unknown_search',
          connectorName: 'Unknown',
        }),
      ]),
    ).toEqual([])
  })
})

describe('Codex App mentions', () => {
  const tools = [
    appTool({
      name: 'mcp__codex_apps__github__search',
      connectorId: 'connector_github',
      connectorName: 'GitHub',
      description: 'Work with repositories',
    }),
    appTool({
      name: 'mcp__codex_apps__github__fetch',
      connectorId: 'connector_github',
      connectorName: 'GitHub',
    }),
    appTool({
      name: 'mcp__codex_apps__gmail__search',
      connectorId: 'connector_gmail',
      connectorName: 'Gmail',
    }),
  ]

  test('extracts and deduplicates @codex-app mentions', () => {
    expect(
      extractCodexAppMentions(
        'Use @codex-app:GitHub and @codex-app:github, not x@codex-app:gmail',
      ),
    ).toEqual(['GitHub'])
  })

  test('resolves mentions against discovered connector names', () => {
    expect(resolveCodexAppMentions(['github'], tools)).toEqual([
      {
        appName: 'GitHub',
        connectorId: 'connector_github',
        description: 'Work with repositories',
        toolNames: [
          'mcp__codex_apps__github__fetch',
          'mcp__codex_apps__github__search',
        ],
      },
    ])
  })

  test('resolves colliding sanitized names to distinct connectors', () => {
    const collidingTools = [
      appTool({
        name: 'mcp__codex_apps__foo_bar__search',
        connectorId: 'connector_foo_bar',
        connectorName: 'Foo Bar',
      }),
      appTool({
        name: 'mcp__codex_apps__foo_bar_alt__search',
        connectorId: 'connector_foo_bar_alt',
        connectorName: 'foo_bar',
      }),
    ]
    const projections = buildCodexAppPluginProjections(collidingTools)

    expect(projections.map(projection => projection.mentionName)).toEqual([
      'foo_bar-21d7cd4c',
      'foo_bar-9b5a8e8a',
    ])
    expect(
      resolveCodexAppMentions(
        projections.map(projection => projection.mentionName),
        collidingTools,
      ).map(app => app.connectorId),
    ).toEqual(['connector_foo_bar', 'connector_foo_bar_alt'])
  })

  test('ignores unknown apps instead of granting new capabilities', () => {
    expect(resolveCodexAppMentions(['unknown'], tools)).toEqual([])
  })
})
