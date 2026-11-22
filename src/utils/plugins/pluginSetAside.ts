/**
 * Options and secrets that were set aside when a marketplace the organization
 * declares replaced another source of the same name. They are stored next to
 * the live ones under `.set-aside/<stamp>/<plugin id>` keys.
 */
import { getSecureStorage } from '../secureStorage/index.js'
import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

type PluginConfig = NonNullable<SettingsJson['pluginConfigs']>[string]
type Secrets = Record<string, Record<string, unknown>>

const PREFIX = '.set-aside/'

/** The plugin id (or `<id>/<server>`) a set-aside key was stored under. */
function setAsideOwner(key: string): string | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  const slash = key.indexOf('/', PREFIX.length)
  return slash === -1 ? undefined : key.slice(slash + 1)
}

function setAsideKeys(stored: Record<string, unknown>, pluginId: string) {
  const inlineName = pluginId.endsWith('@inline')
    ? pluginId.slice(0, -'@inline'.length)
    : ''
  const ids =
    inlineName !== '' && !inlineName.includes('@')
      ? [inlineName, pluginId]
      : [pluginId]
  return Object.keys(stored)
    .filter(key => {
      const owner = setAsideOwner(key)
      return (
        owner !== undefined &&
        ids.some(id => owner === id || owner.startsWith(`${id}/`))
      )
    })
    .sort()
}

function mergeConfig(
  under: PluginConfig | undefined,
  over: PluginConfig | undefined,
): PluginConfig {
  const mcpServers = { ...under?.mcpServers }
  for (const [name, values] of Object.entries(over?.mcpServers ?? {})) {
    mcpServers[name] = { ...mcpServers[name], ...values }
  }
  return {
    ...under,
    ...over,
    ...((under?.options !== undefined || over?.options !== undefined) && {
      options: { ...under?.options, ...over?.options },
    }),
    ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
  }
}

/**
 * The `pluginConfigs` update that removes what is set aside for a plugin and,
 * unless discarding, gives it back to the plugin id; current values win.
 */
export function restoreSetAsideConfigs(
  configs: Record<string, PluginConfig>,
  pluginId: string,
  discard: boolean,
): { count: number; update: Record<string, PluginConfig | undefined> } {
  const keys = setAsideKeys(configs, pluginId)
  const update: Record<string, PluginConfig | undefined> = {}
  for (const key of keys) update[key] = undefined
  if (!discard) {
    const restored: Record<string, PluginConfig> = {}
    for (const key of keys) {
      const owner = setAsideOwner(key)!
      restored[owner] = mergeConfig(restored[owner], configs[key])
    }
    for (const [owner, config] of Object.entries(restored)) {
      update[owner] = mergeConfig(config, configs[owner])
    }
  }
  return { count: keys.length, update }
}

/** `pluginSecrets` without what is set aside for a plugin, restored or not. */
export function restoreSetAsideSecrets(
  secrets: Secrets,
  pluginId: string,
  discard: boolean,
): { count: number; secrets: Secrets | undefined } {
  const keys = setAsideKeys(secrets, pluginId)
  const next = { ...secrets }
  const restored: Secrets = {}
  for (const key of keys) {
    const owner = setAsideOwner(key)!
    delete next[key]
    restored[owner] = { ...restored[owner], ...secrets[key] }
  }
  if (!discard) {
    for (const [owner, values] of Object.entries(restored)) {
      next[owner] = { ...values, ...secrets[owner] }
    }
  }
  return {
    count: keys.length,
    secrets: Object.keys(next).length > 0 ? next : undefined,
  }
}

type StoredSecrets = { pluginSecrets?: Secrets; [key: string]: unknown }

// The declared SecureStorage type does not describe what the backends do.
function secretStorage() {
  return getSecureStorage() as unknown as {
    read(): StoredSecrets | null
    update(data: StoredSecrets): { success: boolean }
  }
}

/** Restore or discard a plugin's set-aside secrets in secure storage. */
export function saveRestoredSetAsideSecrets(
  pluginId: string,
  discard: boolean,
): { count: number; saved: boolean } {
  try {
    const storage = secretStorage()
    const stored = storage.read()
    const { count, secrets } = restoreSetAsideSecrets(
      stored?.pluginSecrets ?? {},
      pluginId,
      discard,
    )
    return {
      count,
      saved:
        count === 0 ||
        storage.update({ ...stored, pluginSecrets: secrets }).success,
    }
  } catch {
    return { count: 0, saved: false }
  }
}

/** Plugin ids with options or secrets set aside in the user's storage. */
export function storedSetAsidePluginIds(): string[] {
  let secrets: Secrets = {}
  try {
    secrets = secretStorage().read()?.pluginSecrets ?? {}
  } catch {
    // Secrets that cannot be read are not listed.
  }
  return setAsidePluginIds(
    getSettingsForSource('userSettings')?.pluginConfigs ?? {},
    secrets,
  )
}

/** Plugin ids that have options or secrets set aside. */
export function setAsidePluginIds(
  configs: Record<string, unknown>,
  secrets: Record<string, unknown>,
): string[] {
  const ids = [...Object.keys(configs), ...Object.keys(secrets)].flatMap(
    key => setAsideOwner(key)?.split('/')[0] ?? [],
  )
  return [...new Set(ids)].sort()
}
