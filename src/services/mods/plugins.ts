import { dirname, resolve } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import { validateUserConfig } from '../../utils/plugins/mcpbHandler.js'
import { getPluginStorageId } from '../../utils/plugins/pluginOptionsStorage.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { ModDiagnostic, ModPluginInput } from './runtime.js'

export type PrepareModPluginsSettings = {
  userSettings: SettingsJson | null
  flagSettings: SettingsJson | null
  policySettings: SettingsJson | null
  hookPolicy: {
    /** Result of shouldAllowManagedHooksOnly(). */
    managedOnly: boolean
    /** Result of shouldDisableAllHooksIncludingManaged(). */
    allDisabled: boolean
  }
  enabledOptionSources?: {
    user: boolean
    flag: boolean
  }
}

type PluginOptions = Record<string, string | number | boolean | string[]>
type UnmodeledOrderingSettings = SettingsJson & {
  prependPlugins?: unknown
  appendPlugins?: unknown
}

function diagnostic(
  plugin: string,
  stage: string,
  message: string,
): ModDiagnostic {
  return { plugin, stage, message }
}

function configuredOptions(
  storageId: string,
  settings: PrepareModPluginsSettings,
): PluginOptions {
  const result: PluginOptions = {}
  const enabled = settings.enabledOptionSources ?? { user: true, flag: true }
  for (const source of [
    enabled.user ? settings.userSettings : null,
    enabled.flag ? settings.flagSettings : null,
    settings.policySettings,
  ]) {
    Object.assign(result, source?.pluginConfigs?.[storageId]?.options)
  }
  return result
}

function prepareOptions(
  plugin: LoadedPlugin,
  storageId: string,
  settings: PrepareModPluginsSettings,
): { options?: PluginOptions; error?: ModDiagnostic } {
  const schema = plugin.manifest.userConfig ?? {}
  const sensitive = Object.entries(schema)
    .filter(([, field]) => field.sensitive === true)
    .map(([key]) => key)
  if (sensitive.length > 0) {
    return {
      error: diagnostic(
        plugin.name,
        'options',
        `Sensitive plugin options are unsupported by Mods: ${sensitive.join(', ')}; module not loaded`,
      ),
    }
  }

  const saved = configuredOptions(storageId, settings)
  const options: PluginOptions = {}
  for (const [key, field] of Object.entries(schema)) {
    if (!(field.required && field.default === undefined)) {
      options[key] = field.default ?? ''
    }
    if (saved[key] !== undefined) options[key] = saved[key]
  }

  const validation = validateUserConfig(options, schema)
  if (!validation.valid) {
    return {
      error: diagnostic(
        plugin.name,
        'options',
        `Options do not fit plugin.json userConfig: ${validation.errors.join('; ')}`,
      ),
    }
  }
  return { options }
}

function hasOrderingSettings(settings: PrepareModPluginsSettings): boolean {
  return [
    settings.userSettings,
    settings.flagSettings,
    settings.policySettings,
  ].some((source) => {
    const value = source as UnmodeledOrderingSettings | null
    return (
      value?.prependPlugins !== undefined || value?.appendPlugins !== undefined
    )
  })
}

/**
 * Converts already-loaded, trusted plugins into declarations for createModsRuntime.
 * This adapter performs no filesystem access and never reads secure option storage.
 */
export function prepareModPlugins(
  plugins: readonly LoadedPlugin[],
  settings: PrepareModPluginsSettings,
): { inputs: ModPluginInput[]; errors: ModDiagnostic[] } {
  const inputs: ModPluginInput[] = []
  const errors: ModDiagnostic[] = []
  const policyEnabled = settings.policySettings?.enabledPlugins
  const allDisabled =
    settings.hookPolicy.allDisabled ||
    settings.policySettings?.disableAllHooks === true
  const managedOnly =
    settings.hookPolicy.managedOnly ||
    settings.policySettings?.allowManagedHooksOnly === true ||
    settings.userSettings?.disableAllHooks === true ||
    settings.flagSettings?.disableAllHooks === true

  if (hasOrderingSettings(settings)) {
    errors.push(
      diagnostic(
        'mods',
        'ordering',
        'prependPlugins/appendPlugins are not available in the local settings schema; configured Mods ordering was not applied',
      ),
    )
  }

  for (const plugin of plugins) {
    if (plugin.enabled === false) continue
    const entrypoints = [
      ...new Set(
        (plugin.hookModules ?? []).flatMap((group) =>
          group.paths.map((path) => resolve(dirname(group.configPath), path)),
        ),
      ),
    ]
    if (entrypoints.length === 0) continue

    const storageId = getPluginStorageId(plugin)
    const managed = policyEnabled?.[storageId] === true
    if (allDisabled) {
      errors.push(
        diagnostic(
          plugin.name,
          'policy',
          'Hooks modules are disabled by managed policy',
        ),
      )
      continue
    }
    if (managedOnly && !managed) {
      errors.push(
        diagnostic(
          plugin.name,
          'policy',
          'Hooks modules are restricted to managed plugins',
        ),
      )
      continue
    }

    const prepared = prepareOptions(plugin, storageId, settings)
    if (prepared.error) {
      errors.push(prepared.error)
      continue
    }

    const builtin = plugin.isBuiltin === true && storageId.endsWith('@builtin')
    inputs.push({
      name: plugin.name,
      storageId,
      pluginRoot: plugin.path,
      entrypoints,
      options: prepared.options,
      tier: builtin ? 'builtin' : managed ? 'prepend' : 'user',
    })
  }

  return { inputs, errors }
}
