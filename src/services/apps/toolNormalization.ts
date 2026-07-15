import { CODEX_APPS_SERVER_NAME, type CodexAppsConnectorInfo } from './types.js'

/** Mirrors codex_utils_plugins::mcp_connector::sanitize_name. */
export function sanitizeCodexAppsName(value: string): string {
  const normalized = Array.from(value, character =>
    /[a-zA-Z0-9]/.test(character) ? character.toLowerCase() : '_',
  )
    .join('')
    .replace(/^_+|_+$/g, '')
  return normalized || 'app'
}

export function normalizeCodexAppsCallableName(
  wireToolName: string,
  connector: CodexAppsConnectorInfo,
): string {
  const toolName = sanitizeCodexAppsName(wireToolName)
  for (const prefix of [connector.name, connector.id]) {
    if (!prefix) continue
    const normalizedPrefix = sanitizeCodexAppsName(prefix)
    if (toolName.startsWith(normalizedPrefix)) {
      const stripped = toolName.slice(normalizedPrefix.length)
      if (stripped) return stripped.replace(/^_+/, '') || toolName
    }
  }
  return toolName
}

export function normalizeCodexAppsNamespace(
  connector: CodexAppsConnectorInfo,
): string {
  return connector.name
    ? `${CODEX_APPS_SERVER_NAME}__${sanitizeCodexAppsName(connector.name)}`
    : CODEX_APPS_SERVER_NAME
}

export function normalizeCodexAppsTitle(
  value: string,
  connector: CodexAppsConnectorInfo,
): string {
  const name = connector.name?.trim()
  if (!name) return value
  const prefix = `${name}_`
  return value.startsWith(prefix) && value.length > prefix.length
    ? value.slice(prefix.length)
    : value
}

export function buildCodexAppsModelToolName(
  wireToolName: string,
  connector: CodexAppsConnectorInfo,
): { name: string; permissionToolName: string; callableName: string } {
  const namespace = normalizeCodexAppsNamespace(connector)
  const callableName = normalizeCodexAppsCallableName(wireToolName, connector)
  const permissionToolName = namespace.startsWith(`${CODEX_APPS_SERVER_NAME}__`)
    ? `${namespace.slice(CODEX_APPS_SERVER_NAME.length + 2)}__${callableName}`
    : callableName
  return {
    name: `mcp__${namespace}__${callableName}`,
    permissionToolName,
    callableName,
  }
}

export function buildCodexAppsSearchHint(
  connector: CodexAppsConnectorInfo,
  existingHint?: string,
): string | undefined {
  const connectorName = connector.name?.trim()
  const pluginDisplayName = connectorName
    ? `CodexApp_${connectorName
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')}`
    : undefined
  const values = [
    pluginDisplayName,
    connectorName,
    connector.description?.trim(),
    existingHint?.replace(/\s+/g, ' ').trim(),
  ].filter((value): value is string => Boolean(value))
  return values.length > 0 ? [...new Set(values)].join(' ') : undefined
}
