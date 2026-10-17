/**
 * Built-in Plugin Registry
 *
 * Manages built-in plugins that ship with the CLI and can be enabled/disabled
 * by users via the /plugin UI.
 *
 * Built-in plugins differ from bundled skills (src/skills/bundled/) in that:
 * - They appear in the /plugin UI under a "Built-in" section
 * - Users can enable/disable them (persisted to user settings)
 * - They can provide multiple components (skills, hooks, MCP servers)
 *
 * Plugin IDs use the format `{name}@builtin` to distinguish them from
 * marketplace plugins (`{name}@{marketplace}`).
 */

import type { Command } from '../commands.js'
import type { BundledSkillDefinition } from '../skills/bundledSkills.js'
import type { BuiltinPluginDefinition, LoadedPlugin } from '../types/plugin.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import type { ModPluginInput } from '../services/mods/runtime.js'
import type { ModDeclaration } from '../services/mods/types.js'
import { createHash } from 'node:crypto'
import {dirname, resolve} from 'node:path'
import {isVerifiedOfficialBuiltinModDefinition} from './builtinMods.js'
import {getVerifiedOfficialShippedModDeclaration, getVerifiedShippedModAvailability, clearOfficialShippedPaneRequests, isVerifiedOfficialShippedModDefinition} from './builtinShippedMods.js'
import {isLoadedSessionOnlyPlugin} from '../utils/plugins/pluginLoader.js'

const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()
type BuiltinModIdentity = { canonicalName: 'cc-plugin-diff'; definition: BuiltinPluginDefinition }
const builtinModPlugins = new WeakMap<LoadedPlugin, BuiltinModIdentity & {
  name:string; source:string; path:string; entrypoints:readonly string[]
}>()
const builtinModInputs = new WeakMap<ModPluginInput, BuiltinModIdentity & {
  name:string; storageId:string; pluginRoot:string; entrypoints:readonly string[]
}>()

function validBuiltinModDefinition(definition:BuiltinPluginDefinition): boolean {
  return ['diff','cc-plugin-diff'].includes(definition.name) &&
    (isVerifiedOfficialBuiltinModDefinition(definition) || isVerifiedOfficialShippedModDefinition(definition))
}

function diffDefinition(): BuiltinPluginDefinition | undefined {
  const definition = BUILTIN_PLUGINS.get('cc-plugin-diff') ?? BUILTIN_PLUGINS.get('diff')
  return definition && validBuiltinModDefinition(definition) ? definition : undefined
}

function builtinModEnabled(definition: BuiltinPluginDefinition): boolean {
  const settings = getSettings_DEPRECATED()
  const value = settings?.enabledPlugins?.['cc-plugin-diff@builtin'] ?? settings?.enabledPlugins?.['diff@builtin']
  return (definition.isAvailable?.() ?? true) &&
    (value === undefined ? definition.defaultEnabled ?? true : value === true || Array.isArray(value))
}

function rememberBuiltinModPlugin(plugin:LoadedPlugin, definition:BuiltinPluginDefinition): void {
  builtinModPlugins.set(plugin,{canonicalName:'cc-plugin-diff',definition,
    name:plugin.name,source:plugin.source,path:plugin.path,
    entrypoints:[...new Set((plugin.hookModules ?? []).flatMap(group => group.paths.map(path => resolve(dirname(group.configPath),path))))],
  })
}

export function isCanonicalDiffPlugin(plugin: LoadedPlugin): boolean {
  const definition=diffDefinition()
  if (definition && !builtinModPlugins.has(plugin) && isLoadedSessionOnlyPlugin(plugin) &&
      ['diff','cc-plugin-diff'].includes(plugin.name) && plugin.source === `${plugin.name}@inline`)
    rememberBuiltinModPlugin(plugin, definition)
  const identity=builtinModPlugins.get(plugin)
  return Boolean(identity && definition && validBuiltinModDefinition(identity.definition) && builtinModEnabled(definition) &&
    plugin.enabled !== false && plugin.name === identity.name && plugin.source === identity.source && plugin.path === identity.path)
}

export function markBuiltinModInput(plugin: LoadedPlugin, input: ModPluginInput): void {
  if (!isCanonicalDiffPlugin(plugin)) return
  const identity = builtinModPlugins.get(plugin)
  if (identity && isCanonicalDiffPlugin(plugin) && input.name === identity.name && input.storageId === identity.source && input.pluginRoot === identity.path &&
      input.entrypoints.length === identity.entrypoints.length && input.entrypoints.every((path,index) => path === identity.entrypoints[index]))
    builtinModInputs.set(input, {...identity,name:input.name,storageId:input.storageId,
      pluginRoot:input.pluginRoot,entrypoints:[...input.entrypoints]})
}

export function isCanonicalDiffMod(input: ModPluginInput): boolean {
  const identity = builtinModInputs.get(input)
  const definition = diffDefinition()
  return Boolean(identity && definition && validBuiltinModDefinition(identity.definition) && builtinModEnabled(definition) &&
    input.isNative !== true &&
    input.name === identity.name && input.storageId === identity.storageId && input.pluginRoot === identity.pluginRoot &&
    input.entrypoints.length === identity.entrypoints.length && input.entrypoints.every((path,index) => path === identity.entrypoints[index]))
}

/** An immutable shipped graph never gains the sec-default native-seat privilege. */
export function getShippedBuiltinModDeclaration(input: ModPluginInput): ModDeclaration | undefined {
  if (!isCanonicalDiffMod(input)) return undefined
  const identity = builtinModInputs.get(input)!
  const shipped = getVerifiedOfficialShippedModDeclaration(identity.definition)
  if (!shipped || input.storageId.endsWith('@inline')) return undefined
  const declaration = structuredClone(shipped)
  const options = structuredClone(input.options ?? {})
  const tier = input.tier ?? 'builtin'
  return {...declaration,name:input.name,storageId:input.storageId,options,tier,
    fingerprint:createHash('sha256').update(JSON.stringify({source:declaration.fingerprint,options:input.fingerprintOptions ?? options,tier})).digest('hex')}
}

export const BUILTIN_MARKETPLACE_NAME = 'builtin'

/**
 * Register a built-in plugin. Call this from initBuiltinPlugins() at startup.
 */
export function registerBuiltinPlugin(
  definition: BuiltinPluginDefinition,
): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}

/**
 * Check if a plugin ID represents a built-in plugin (ends with @builtin).
 */
export function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.endsWith(`@${BUILTIN_MARKETPLACE_NAME}`)
}

/**
 * Get a specific built-in plugin definition by name.
 * Useful for the /plugin UI to show the skills/hooks/MCP list without
 * a marketplace lookup.
 */
export function getBuiltinPluginDefinition(
  name: string,
): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.get(name)
}

/**
 * Get all registered built-in plugins as LoadedPlugin objects, split into
 * enabled/disabled based on user settings (with defaultEnabled as fallback).
 * Plugins whose isAvailable() returns false are omitted entirely.
 */
export function getBuiltinPlugins(contractDefinitions?: BuiltinPluginDefinition[]): {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
} {
  const settings = getSettings_DEPRECATED()
  const enabled: LoadedPlugin[] = []
  const disabled: LoadedPlugin[] = []

  if (contractDefinitions) {
    for (const definition of BUILTIN_PLUGINS.values()) {
      if (definition.isAvailable && getVerifiedShippedModAvailability(definition) === undefined)
        throw new Error(`Built-in ${definition.name} availability cannot be determined without executing its callback`)
    }
  }
  const definitions = contractDefinitions
    ? new Map([...BUILTIN_PLUGINS, ...contractDefinitions.map(definition => [definition.name, definition] as const)])
    : BUILTIN_PLUGINS
  for (const [name, definition] of definitions) {
    if (contractDefinitions && definition.isAvailable && getVerifiedShippedModAvailability(definition) === undefined)
      throw new Error(`Built-in ${name} availability cannot be determined without executing its callback`)
    if (definition.isAvailable && !(contractDefinitions ? getVerifiedShippedModAvailability(definition) : definition.isAvailable())) {
      continue
    }

    const pluginId = `${name}@${BUILTIN_MARKETPLACE_NAME}`
    const userSetting = validBuiltinModDefinition(definition) ||
      (contractDefinitions && name==='cc-plugin-diff' && getVerifiedShippedModAvailability(definition)!==undefined)
      ? settings?.enabledPlugins?.['cc-plugin-diff@builtin'] ?? settings?.enabledPlugins?.['diff@builtin']
      : settings?.enabledPlugins?.[pluginId]
    // Enabled state: user preference > plugin default > true
    const isEnabled =
      userSetting !== undefined
        ? userSetting === true || Array.isArray(userSetting)
        : (definition.defaultEnabled ?? true)

    const plugin: LoadedPlugin = {
      name,
      manifest: definition.manifest ?? {
        name,
        description: definition.description,
        version: definition.version,
      },
      path: definition.path ?? BUILTIN_MARKETPLACE_NAME,
      source: pluginId,
      repository: pluginId,
      enabled: isEnabled,
      isBuiltin: true,
      hooksConfig: definition.hooks,
      hookModules: definition.hookModules,
      mcpServers: definition.mcpServers,
    }
    if (!contractDefinitions && validBuiltinModDefinition(definition))
      rememberBuiltinModPlugin(plugin, definition)

    if (isEnabled) {
      enabled.push(plugin)
    } else {
      disabled.push(plugin)
    }
  }

  return { enabled, disabled }
}

/**
 * Get skills from enabled built-in plugins as Command objects.
 * Skills from disabled plugins are not returned.
 */
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  const commands: Command[] = []

  for (const plugin of enabled) {
    const definition = BUILTIN_PLUGINS.get(plugin.name)
    if (!definition?.skills) continue
    for (const skill of definition.skills) {
      commands.push(skillDefinitionToCommand(skill))
    }
  }

  return commands
}

/**
 * Clear built-in plugins registry (for testing).
 */
export function clearBuiltinPlugins(): void {
  BUILTIN_PLUGINS.clear()
  clearOfficialShippedPaneRequests()
}

// --

function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0,
    // 'bundled' not 'builtin' — 'builtin' in Command.source means hardcoded
    // slash commands (/help, /clear). Using 'bundled' keeps these skills in
    // the Skill tool's listing, analytics name logging, and prompt-truncation
    // exemption. The user-toggleable aspect is tracked on LoadedPlugin.isBuiltin.
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled ?? (() => true),
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand: definition.getPromptForCommand,
  }
}
