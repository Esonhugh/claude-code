import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import type { MarketplaceSource } from './schemas.js'
import { PluginMarketplaceSchema } from './schemas.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import isEqual from 'lodash-es/isEqual.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { isENOENT } from '../errors.js'
import { stripBOM } from '../jsonRead.js'

function sameDirectory(a: string, b: string): boolean {
  return isAbsolute(a) && isAbsolute(b) && resolve(a) === resolve(b)
}

function sameDeclaredSource(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.source !== b.source) return false
  if ((a.source === 'directory' || a.source === 'file') && (b.source === 'directory' || b.source === 'file')) return sameDirectory(a.path,b.path)
  const fields = (source: MarketplaceSource) => Object.fromEntries(Object.entries(source).filter(([key,value]) => value !== undefined && (!['ref','path'].includes(key) || value !== '')))
  return isEqual(fields(a),fields(b))
}

/** A refused registration remains distinct from a missing or unreadable catalog. */
export function getMarketplaceDeclarationRefusal(
  source: MarketplaceSource | undefined,
  declaration: MarketplaceSource | undefined,
): { kind: 'declaration'; reason: string } | undefined {
  if (source && source.source !== 'directory' && source.source !== 'file' &&
      declaration && !sameDeclaredSource(source, declaration)) {
    return {
      kind: 'declaration',
      reason: "its source doesn't match its extraKnownMarketplaces entry in user or managed settings",
    }
  }
  return undefined
}

/** Read local marketplace content in place; trust belongs to its actual registered source. */
export async function getInPlacePluginSource(
  pluginId: string,
  policy: SettingsJson | null,
  registered?: { source?: MarketplaceSource; installLocation: string },
  declaration?: MarketplaceSource,
) {
  const {name,marketplace}=parsePluginIdentifier(pluginId)
  if (!marketplace || marketplace === 'inline' || marketplace === 'builtin') return undefined
  const policySource=policy?.extraKnownMarketplaces?.[marketplace]?.source
  const declared=declaration ?? policySource
  // A legacy registration without provenance remains a cached, ordinary plugin.
  if (registered && !registered.source) return undefined
  const source=registered?.source ?? declared
  if (!source) return undefined
  const refusal = registered && getMarketplaceDeclarationRefusal(source, declared)
  if (refusal) {
    throw new Error(`Marketplace "${marketplace}" is ignored everywhere: ${refusal.reason} — re-add the marketplace from the source that entry lists, or change the entry.`)
  }
  if (source.source !== 'directory' || !isAbsolute(source.path)) return undefined
  const location=registered?.installLocation ?? source.path
  const root=await realpath(location)
  const catalog=PluginMarketplaceSchema().parse(JSON.parse(stripBOM(await readFile(join(root,'.claude-plugin','marketplace.json'),'utf8'))))
  if (catalog.name !== marketplace) return undefined
  const entry=catalog.plugins.find(plugin=>plugin.name===name)
  if (!entry || typeof entry.source !== 'string' || isAbsolute(entry.source)) return undefined
  const candidate=relative(root,join(root,entry.source))
  if (candidate==='..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return undefined
  const entryPath=join(root,entry.source)
  const path=await realpath(entryPath).catch(error => {
    if (!isENOENT(error)) throw error
    throw new Error(`Plugin directory not found at path: ${entryPath}. Check that the marketplace entry has the correct path.`)
  })
  const child=relative(root,path)
  if (child==='..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !(await stat(path)).isDirectory()) return undefined
  const managedSource=policy?.enabledPlugins?.[pluginId]===true && policySource?.source==='directory' &&
    sameDirectory(source.path,location) && sameDirectory(source.path,policySource.path)
  return {entry,path,source,managedSource,root}
}

/**
 * For a plugin loaded in place, the error for a component path that resolves
 * outside its marketplace directory; such a path must not be read.
 */
export async function getInPlaceEscapeError(
  plugin: Pick<LoadedPlugin, 'name' | 'source' | 'containmentRoot'>,
  path: string,
  component: string,
): Promise<PluginError | undefined> {
  const root = plugin.containmentRoot
  if (root === undefined) return undefined
  const real = await realpath(path).catch(() => resolve(path))
  if (real === root || real.startsWith(root + sep)) return undefined
  logForDebugging(`Plugin ${plugin.name}: did not read ${path}: it resolves to ${real}, outside ${root}`, { level: 'error' })
  return { type: 'generic-error', source: plugin.source, plugin: plugin.name, error: `Path escapes plugin directory: ${path} (${component})` }
}


/**
 * Plugin names locked by org policy (policySettings.enabledPlugins).
 *
 * Returns null when managed settings declare no plugin entries (common
 * case — no policy in effect).
 */
export function getManagedPluginNames(): Set<string> | null {
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  if (!enabledPlugins) {
    return null
  }
  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // Only plugin@marketplace boolean entries (true OR false) are
    // protected. Legacy owner/repo array form is not.
    if (typeof value !== 'boolean' || !pluginId.includes('@')) {
      continue
    }
    const name = pluginId.split('@')[0]
    if (name) {
      names.add(name)
    }
  }
  return names.size > 0 ? names : null
}
