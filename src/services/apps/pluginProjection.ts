import { createHash } from 'crypto'
import type { Tool } from '../../Tool.js'
import { CODEX_APPS_SERVER_NAME } from './types.js'
import { sanitizeCodexAppsName } from './toolNormalization.js'

export const CODEX_APPS_PLUGIN_MARKETPLACE = 'chatgpt-connectors'

export type ResolvedCodexAppMention = {
  appName: string
  connectorId: string
  description?: string
  toolNames: string[]
}

export type CodexAppPluginProjection = {
  kind: 'connector-projection'
  /** Local discovery/UI identity. Never send this to plugin-service mutations. */
  pluginId: string
  pluginName: string
  displayName: string
  marketplace: typeof CODEX_APPS_PLUGIN_MARKETPLACE
  connectorId: string
  connectorName: string
  description?: string
  status: 'available'
  toolNames: string[]
  tools: Tool[]
}

function shortConnectorHash(connectorId: string): string {
  return createHash('sha256').update(connectorId).digest('hex').slice(0, 8)
}

function projectionDisplayName(connectorName: string): string {
  return connectorName.trim() || 'App'
}

export function extractCodexAppMentions(content: string): string[] {
  const mentions: string[] = []
  const seen = new Set<string>()
  const mentionRegex = /(^|\s)@codex-app:([a-zA-Z0-9][\w.-]*)\b/g
  let match: RegExpExecArray | null

  while ((match = mentionRegex.exec(content)) !== null) {
    const appName = match[2]
    if (!appName) continue
    const normalizedName = sanitizeCodexAppsName(appName)
    if (seen.has(normalizedName)) continue
    seen.add(normalizedName)
    mentions.push(appName)
  }

  return mentions
}

export function resolveCodexAppMentions(
  mentions: readonly string[],
  tools: readonly Tool[],
): ResolvedCodexAppMention[] {
  if (mentions.length === 0) return []

  const projections = buildCodexAppPluginProjections(tools)
  const projectionsByName = new Map(
    projections.map(projection => [
      sanitizeCodexAppsName(projection.connectorName),
      projection,
    ]),
  )

  return mentions.flatMap(mention => {
    const projection = projectionsByName.get(sanitizeCodexAppsName(mention))
    if (!projection) return []
    return [
      {
        appName: projection.displayName,
        connectorId: projection.connectorId,
        description: projection.description,
        toolNames: projection.toolNames,
      },
    ]
  })
}

/**
 * Project trusted Codex Apps tools into plugin-like descriptors.
 *
 * These descriptors are deliberately non-installable and runtime-only. They
 * group tools for discovery/UI and local preferences without claiming a
 * backend remotePluginId or creating one MCP connection per connector.
 */
export function buildCodexAppPluginProjections(
  tools: readonly Tool[],
): CodexAppPluginProjection[] {
  const grouped = new Map<
    string,
    {
      connectorName: string
      description?: string
      tools: Tool[]
    }
  >()

  for (const tool of tools) {
    if (tool.mcpInfo?.serverName !== CODEX_APPS_SERVER_NAME) continue
    const connectorId = tool.connectorInfo?.id?.trim()
    if (!connectorId) continue
    const connectorName =
      tool.connectorInfo?.name?.trim() || connectorId
    const existing = grouped.get(connectorId)
    if (existing) {
      existing.tools.push(tool)
      if (!existing.description && tool.connectorInfo?.description?.trim()) {
        existing.description = tool.connectorInfo.description.trim()
      }
      if (
        existing.connectorName === connectorId &&
        connectorName !== connectorId
      ) {
        existing.connectorName = connectorName
      }
    } else {
      grouped.set(connectorId, {
        connectorName,
        description: tool.connectorInfo?.description?.trim() || undefined,
        tools: [tool],
      })
    }
  }

  return [...grouped.entries()]
    .map<CodexAppPluginProjection>(([connectorId, connector]) => {
      const slug = sanitizeCodexAppsName(connector.connectorName).replace(
        /_/g,
        '-',
      )
      const pluginName = `codex-app-${slug}-${shortConnectorHash(connectorId)}`
      const sortedTools = [...connector.tools].sort((a, b) =>
        a.name.localeCompare(b.name),
      )
      return {
        kind: 'connector-projection' as const,
        pluginId: `${pluginName}@${CODEX_APPS_PLUGIN_MARKETPLACE}`,
        pluginName,
        displayName: projectionDisplayName(connector.connectorName),
        marketplace: CODEX_APPS_PLUGIN_MARKETPLACE,
        connectorId,
        connectorName: connector.connectorName,
        description: connector.description,
        status: 'available' as const,
        toolNames: sortedTools.map(tool => tool.name),
        tools: sortedTools,
      }
    })
    .sort((a, b) =>
      a.connectorName.localeCompare(b.connectorName, undefined, {
        sensitivity: 'base',
      }),
    )
}
