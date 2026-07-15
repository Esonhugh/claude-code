import type { CodexAppsConnectorInfo } from './types.js'

const stringMeta = (
  meta: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = meta?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function readCodexAppsConnectorInfo(
  meta: Record<string, unknown> | undefined,
): CodexAppsConnectorInfo {
  return {
    id: stringMeta(meta, 'connector_id'),
    name: stringMeta(meta, 'connector_name', 'connector_display_name'),
    description: stringMeta(
      meta,
      'connector_description',
      'connectorDescription',
    ),
  }
}

export function hasCodexAppsConnectorInfo(
  info: CodexAppsConnectorInfo,
): boolean {
  return Boolean(info.id || info.name || info.description)
}
