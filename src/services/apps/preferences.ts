import type { Tool } from '../../Tool.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { CODEX_APPS_SERVER_NAME } from './types.js'

function normalizeConnectorIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map(id => id.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  )
}

export function getDisabledCodexAppConnectorIds(): Set<string> {
  return new Set(
    normalizeConnectorIds(
      getSettingsForSource('userSettings')?.disabledCodexApps ?? [],
    ),
  )
}

export function isCodexAppEnabled(connectorId: string): boolean {
  return !getDisabledCodexAppConnectorIds().has(connectorId.trim())
}

export function setCodexAppEnabled(
  connectorId: string,
  enabled: boolean,
): void {
  const normalizedId = connectorId.trim()
  if (!normalizedId) throw new Error('Codex App connector ID is required')

  const disabled = getDisabledCodexAppConnectorIds()
  if (enabled) disabled.delete(normalizedId)
  else disabled.add(normalizedId)

  const disabledCodexApps = normalizeConnectorIds(disabled)
  const { error } = updateSettingsForSource('userSettings', {
    disabledCodexApps:
      disabledCodexApps.length > 0 ? disabledCodexApps : undefined,
  })
  if (error) throw error
}

export function toggleCodexAppEnabled(connectorId: string): boolean {
  const enabled = !isCodexAppEnabled(connectorId)
  setCodexAppEnabled(connectorId, enabled)
  return enabled
}

export function filterEnabledCodexAppTools<T extends Tool>(
  tools: readonly T[],
  disabledConnectorIds = getDisabledCodexAppConnectorIds(),
): T[] {
  return tools.filter(
    tool =>
      tool.mcpInfo?.serverName !== CODEX_APPS_SERVER_NAME ||
      !tool.connectorInfo?.id ||
      !disabledConnectorIds.has(tool.connectorInfo.id),
  )
}

export function refreshCodexAppToolExposure(tools: readonly Tool[]): Tool[] {
  // A new array identity invalidates merged/deferred tool memoization while
  // retaining the full catalog for /plugin management and later re-enable.
  return [...tools]
}
