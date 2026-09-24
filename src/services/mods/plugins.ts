import { dirname, resolve } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import { validateUserConfig } from '../../utils/plugins/mcpbHandler.js'
import { getPluginStorageId, loadPluginSecrets, resolvePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { ModDiagnostic, ModPluginInput } from './runtime.js'
import type { ModOrigin } from './types.js'
import { SEC_DEFAULT_ID, shouldSeatSecDefault } from './native.js'

export type PrepareModPluginsSettings = {
  userSettings: SettingsJson | null
  flagSettings: SettingsJson | null
  policySettings: SettingsJson | null
  /** Admin settings remain authoritative even when their contents failed validation. */
  hasManagedSettings?: boolean
  subscriptionType?: 'team' | 'enterprise' | 'pro' | 'max' | null
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

function diagnostic(
  plugin: string,
  stage: string,
  message: string,
): ModDiagnostic {
  return { plugin, stage, message }
}

function configuredOptions(
  plugin: LoadedPlugin,
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
    if (storageId.endsWith('@inline'))
      Object.assign(result, source?.pluginConfigs?.[plugin.name]?.options)
    Object.assign(result, source?.pluginConfigs?.[storageId]?.options)
  }
  return result
}

function prepareOptions(
  plugin: LoadedPlugin,
  storageId: string,
  settings: PrepareModPluginsSettings,
): { options?: PluginOptions; fingerprintOptions?: PluginOptions; error?: ModDiagnostic } {
  const schema = plugin.manifest.userConfig ?? {}
  const hasSensitiveOptions = Object.values(schema).some(field => field.sensitive === true)
  const saved = {
    ...configuredOptions(plugin, storageId, settings),
    ...(hasSensitiveOptions ? loadPluginSecrets(storageId) : {}),
  }
  const options = resolvePluginOptions(schema, saved)
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
  const fingerprintOptions = hasSensitiveOptions
    ? Object.fromEntries(
        Object.entries(options).filter(([key]) => schema[key]?.sensitive !== true),
      )
    : undefined
  return { options, fingerprintOptions }
}

export function getModPluginOrigin(
  plugin: LoadedPlugin,
  settings: PrepareModPluginsSettings,
): ModOrigin {
  const storageId = getPluginStorageId(plugin)
  if (plugin.isBuiltin === true && storageId.endsWith('@builtin'))
    return { plugin: storageId, tier: 'builtin' }
  const managed = settings.policySettings?.enabledPlugins?.[storageId] === true
  const hasPolicy = settings.hasManagedSettings === true ||
    (settings.policySettings !== null && Object.keys(settings.policySettings).length > 0)
  const ordering = hasPolicy ? settings.policySettings :
    settings.enabledOptionSources?.user === false ? null : settings.userSettings
  let tier: ModOrigin['tier'] = managed ? 'prepend' : 'user'
  if (hasPolicy ? managed : !managed) {
    if (ordering?.prependPlugins?.includes(storageId)) tier = 'prepend'
    else if (ordering?.appendPlugins?.includes(storageId)) tier = 'append'
  }
  return { plugin: storageId, tier }
}

/**
 * Converts already-loaded, trusted plugins into declarations for createModsRuntime.
 * Resolves and validates settings and secure options before module evaluation.
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

  const hasPolicy = settings.hasManagedSettings === true ||
    (settings.policySettings !== null && Object.keys(settings.policySettings).length > 0)
  const user = settings.enabledOptionSources?.user === false ? null : settings.userSettings
  const ordering = hasPolicy ? settings.policySettings : user
  const prepend = [...new Set(ordering?.prependPlugins ?? [])]
  const append = [...new Set(ordering?.appendPlugins ?? [])]
  if (hasPolicy) {
    for (const key of ['prependPlugins', 'appendPlugins'] as const) {
      if (user?.[key] !== undefined) errors.push(diagnostic('mods', 'ordering', `${key} in user settings ignored: this machine has managed settings`))
    }
  }
  for (const id of append) {
    if (prepend.includes(id)) errors.push(diagnostic('mods', 'ordering', `${id} is in both tier lists; it is prepended`))
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
    if (shouldSeatSecDefault(settings) && (plugin.name === 'sec-default' || storageId === SEC_DEFAULT_ID)) {
      errors.push(diagnostic(plugin.name, 'native', 'sec-default is host-owned on this session; the external name collision is not loaded'))
      continue
    }
    const trustedBuiltin =
      plugin.isBuiltin === true && storageId === `${plugin.name}@builtin`
    const managed = policyEnabled?.[storageId] === true
    if (!trustedBuiltin && allDisabled) {
      errors.push(
        diagnostic(
          plugin.name,
          'policy',
          'Hooks modules are disabled by managed policy',
        ),
      )
      continue
    }
    if (!trustedBuiltin && managedOnly && !managed) {
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

    inputs.push({
      name: plugin.name,
      ...(plugin.manifest.version === undefined ? {} : { version: plugin.manifest.version }),
      storageId,
      pluginRoot: plugin.path,
      entrypoints,
      options: prepared.options,
      fingerprintOptions: prepared.fingerprintOptions,
      tier: getModPluginOrigin(plugin, settings).tier,
    })
  }

  const eligible = (input: ModPluginInput) => input.tier !== 'builtin' &&
    (hasPolicy ? policyEnabled?.[input.storageId] === true : policyEnabled?.[input.storageId] !== true)
  for (const [key, ids] of [['prependPlugins', prepend], ['appendPlugins', append]] as const) {
    for (const id of ids) {
      if (key === 'prependPlugins' && id === SEC_DEFAULT_ID && shouldSeatSecDefault(settings)) continue
      if (!inputs.some(input => input.storageId === id && eligible(input))) {
        errors.push(diagnostic('mods', 'ordering', `${key} names ${id}, which is not an enabled ${hasPolicy ? 'managed ' : ''}plugin with a hooks module; skipped`))
      }
    }
  }
  const tiers = ['prepend', 'user', 'append', 'builtin']
  const rank = (input: ModPluginInput) => {
    const ids = input.tier === 'prepend' ? prepend : input.tier === 'append' ? append : []
    const index = ids.indexOf(input.storageId)
    return index === -1 ? ids.length : index
  }
  inputs.sort((a, b) => tiers.indexOf(a.tier!) - tiers.indexOf(b.tier!) || rank(a) - rank(b))
  return { inputs, errors }
}
