import { getSettingsForSource } from '../settings/settings.js'

export function areSideloadFlagsDisabled(): boolean {
  return getSettingsForSource('policySettings')?.disableSideloadFlags === true
}

export function getSideloadFlagsError(flags: readonly string[]): string {
  return `${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} disabled by your organization's managed settings (disableSideloadFlags). Plugins, custom agents, and MCP servers can only be loaded from sources your administrator has approved. Ask your administrator to remove disableSideloadFlags from managed settings, or use an approved marketplace / settings file instead.`
}

export function getSideloadStartupError(
  options: Readonly<Record<string, unknown>>,
  environmentPaths: readonly string[],
  actionOptions: Readonly<Record<string, unknown>> = {},
  initializePluginCount = 0,
): string | undefined {
  if (!areSideloadFlagsDisabled()) return undefined
  const populated = (value: unknown) => Array.isArray(value)
    ? value.length > 0 : typeof value === 'string' && value.length > 0
  const flags: string[] = []
  for (const [key, flag] of [
    ['pluginDir', '--plugin-dir'], ['pluginDirNoMcp', '--plugin-dir-no-mcp'],
    ['pluginUrl', '--plugin-url'], ['agents', '--agents'],
  ] as const) {
    if (populated(options[key]) || populated(actionOptions[key])) flags.push(flag)
  }
  if (initializePluginCount > 0) flags.push('plugins (initialize request)')
  if (environmentPaths.length > 0) flags.push('CLAUDE_CODE_PLUGIN_DIRS')
  if (flags.length === 0) return undefined
  const error = getSideloadFlagsError(flags)
  return environmentPaths.length > 0
    ? `${error} Unset CLAUDE_CODE_PLUGIN_DIRS (in the environment, or in the settings \`env\` block that sets it) to run without those folders.`
    : error
}

export function filterSideloadMcpServers<T extends { type?: string }>(
  servers: Record<string, T>,
  drop: boolean,
): { servers: Record<string, T>; dropped: string[] } {
  if (!drop) return { servers, dropped: [] }
  const kept: Record<string, T> = {}
  const dropped: string[] = []
  for (const [name, config] of Object.entries(servers)) {
    if (config.type === 'sdk') kept[name] = config
    else dropped.push(name)
  }
  return { servers: kept, dropped }
}
