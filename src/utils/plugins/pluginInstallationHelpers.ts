/**
 * Shared helper functions for plugin installation
 *
 * This module contains common utilities used across the plugin installation
 * system to reduce code duplication and improve maintainability.
 */

import { rename, rm } from 'fs/promises'
import { resolve, sep } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { getErrnoCode, toError } from '../errors.js'
import { pathExists, writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { getEnabledSettingSources } from '../settings/constants.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { buildPluginTelemetryFields } from '../telemetry/pluginTelemetry.js'
import { clearAllCaches } from './cacheUtils.js'
import {
  dependencyMatchesPlugin,
  formatDependencyCountSuffix,
  getEnabledPluginIdsForScope,
  qualifyDependency,
  type ResolutionResult,
  resolveDependencyClosure,
} from './dependencyResolver.js'
import {
  addInstalledPlugin,
  getGitCommitSha,
  getInstalledPluginsReadRefusal,
  loadInstalledPluginsFromDisk,
} from './installedPluginsManager.js'
import { findPluginFolderCollision, PluginFolderCollisionError } from './pluginFolderCollision.js'
import { getManagedPluginNames } from './managedPlugins.js'
import { getMarketplaceCacheOnly, getPluginById } from './marketplaceManager.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
  scopeToSettingSource,
} from './pluginIdentifier.js'
import {
  cachePlugin,
  getVersionedCachePath,
  getVersionedZipCachePath,
  loadAllPluginsCacheOnly,
} from './pluginLoader.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'
import { calculatePluginVersion } from './pluginVersioning.js'
import {
  isLocalPluginSource,
  type PluginManifest,
  type PluginMarketplaceEntry,
  type PluginScope,
  type PluginSource,
} from './schemas.js'
import { isPluginZipCacheEnabled } from './zipCache.js'
import { publishDirectory } from './stagingDirectory.js'

/**
 * Plugin installation metadata for installed_plugins.json
 */
export type PluginInstallationInfo = {
  pluginId: string
  installPath: string
  version?: string
}

/**
 * Get current ISO timestamp
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Validate that a resolved path stays within a base directory.
 * Prevents path traversal attacks where malicious paths like './../../../etc/passwd'
 * could escape the expected directory.
 *
 * @param basePath - The base directory that the resolved path must stay within
 * @param relativePath - The relative path to validate
 * @returns The validated absolute path
 * @throws Error if the path would escape the base directory
 */
export function validatePathWithinBase(
  basePath: string,
  relativePath: string,
): string {
  const resolvedPath = resolve(basePath, relativePath)
  const normalizedBase = resolve(basePath) + sep

  // Check if the resolved path starts with the base path
  // Adding sep ensures we don't match partial directory names
  // e.g., /foo/bar should not match /foo/barbaz
  if (
    !resolvedPath.startsWith(normalizedBase) &&
    resolvedPath !== resolve(basePath)
  ) {
    throw new Error(
      `Path traversal detected: "${relativePath}" would escape the base directory`,
    )
  }

  return resolvedPath
}

/**
 * Cache a plugin (local or external) and add it to installed_plugins.json
 *
 * This function combines the common pattern of:
 * 1. Caching a plugin to ~/.claude/plugins/cache/
 * 2. Adding it to the installed plugins registry
 *
 * Both local plugins (with string source like "./path") and external plugins
 * (with object source like {source: "github", ...}) are cached to the same
 * location to ensure consistent behavior.
 *
 * @param pluginId - Plugin ID in "plugin@marketplace" format
 * @param entry - Plugin marketplace entry
 * @param scope - Installation scope (user, project, local, or managed). Defaults to 'user'.
 *                'managed' scope is used for plugins installed automatically from managed settings.
 * @param projectPath - Project path (required for project/local scopes)
 * @param localSourcePath - For local plugins, the resolved absolute path to the source directory
 * @returns The installation path and the plugin's manifest
 */
export async function cacheAndRegisterPlugin(
  pluginId: string,
  entry: PluginMarketplaceEntry,
  scope: PluginScope = 'user',
  projectPath?: string,
  localSourcePath?: string,
): Promise<{ path: string; manifest: PluginManifest }> {
  const installedPlugins = loadInstalledPluginsFromDisk().plugins
  const collision = findPluginFolderCollision([pluginId], installedPlugins)
  if (collision) throw new PluginFolderCollisionError(collision, pluginId)
  const source: PluginSource =
    typeof entry.source === 'string' && localSourcePath
      ? (localSourcePath as PluginSource)
      : entry.source
  // Keep the validated download in its unique directory. A manifest name can
  // equal a marketplace name; the legacy name cache would remove that tree.
  const cached = await cachePlugin(source, {
    manifest: entry,
    keepTemporary: true,
  })
  const errors: unknown[] = []
  let finalPath: string | undefined
  try {
    const pathForGitSha = localSourcePath || cached.path
    const gitCommitSha =
      cached.gitCommitSha ?? (await getGitCommitSha(pathForGitSha))
    const version = await calculatePluginVersion(
      pluginId,
      entry.source,
      cached.manifest,
      pathForGitSha,
      entry.version,
      cached.gitCommitSha,
    )
    const now = getCurrentTimestamp()
    const versionedPath = getVersionedCachePath(pluginId, version)
    const zipPath = isPluginZipCacheEnabled()
      ? getVersionedZipCachePath(pluginId, version)
      : undefined
    const publishedPath = zipPath ?? versionedPath
    // Another scope's installation of this version may be in use by a running
    // session; reuse its tree instead of replacing it. Reinstalling at the
    // same scope still republishes.
    const sharedWithOtherInstall = (installedPlugins[pluginId] ?? []).some(
      inst =>
        inst.installPath === publishedPath &&
        !(inst.scope === scope && inst.projectPath === projectPath),
    )
    if (!sharedWithOtherInstall || !(await pathExists(publishedPath))) {
      await publishDirectory(
        versionedPath,
        staging => rename(cached.path, staging),
        zipPath,
      )
    }
    finalPath = publishedPath
    addInstalledPlugin(
      pluginId,
      {
        version,
        installedAt: now,
        lastUpdated: now,
        installPath: finalPath,
        gitCommitSha,
      },
      scope,
      projectPath,
    )
  } catch (error) {
    errors.push(error)
  }
  // Metadata or publication can fail before the owned download is moved.
  try {
    await rm(cached.path, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, `Plugin installation failed: ${pluginId}`)
  return { path: finalPath!, manifest: cached.manifest }
}

/**
 * Register a plugin installation without caching
 *
 * Used for local plugins that are already on disk and don't need remote caching.
 * External plugins should use cacheAndRegisterPlugin() instead.
 *
 * @param info - Plugin installation information
 * @param scope - Installation scope (user, project, local, or managed). Defaults to 'user'.
 *                'managed' scope is used for plugins registered from managed settings.
 * @param projectPath - Project path (required for project/local scopes)
 */
export function registerPluginInstallation(
  info: PluginInstallationInfo,
  scope: PluginScope = 'user',
  projectPath?: string,
): void {
  const now = getCurrentTimestamp()
  addInstalledPlugin(
    info.pluginId,
    {
      version: info.version || 'unknown',
      installedAt: now,
      lastUpdated: now,
      installPath: info.installPath,
    },
    scope,
    projectPath,
  )
}

/**
 * Parse plugin ID into components
 *
 * @param pluginId - Plugin ID in "plugin@marketplace" format
 * @returns Parsed components or null if invalid
 */
export function parsePluginId(
  pluginId: string,
): { name: string; marketplace: string } | null {
  const parts = pluginId.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  return {
    name: parts[0],
    marketplace: parts[1],
  }
}

/**
 * Structured result from the install core. Wrappers format messages and
 * handle analytics/error-catching around this.
 */
export type InstallCoreResult =
  | { ok: true; closure: string[]; depNote: string }
  | { ok: false; reason: 'local-source-no-location'; pluginName: string }
  | { ok: false; reason: 'settings-write-failed'; message: string }
  | {
      ok: false
      reason: 'resolution-failed'
      resolution: ResolutionResult & { ok: false }
    }
  | { ok: false; reason: 'blocked-by-policy'; pluginName: string }
  | {
      ok: false
      reason: 'dependency-blocked-by-policy'
      pluginName: string
      blockedDependency: string
    }

/**
 * Format a failed ResolutionResult into a user-facing message. Unified on
 * the richer CLI messages (the "Is the X marketplace added?" hint is useful
 * for UI users too).
 */
export function formatResolutionError(
  r: ResolutionResult & { ok: false },
): string {
  switch (r.reason) {
    case 'cycle':
      return `Dependency cycle: ${r.chain.join(' → ')}`
    case 'cross-marketplace': {
      const depMkt = parsePluginIdentifier(r.dependency).marketplace
      const where = depMkt
        ? `marketplace "${depMkt}"`
        : 'a different marketplace'
      const hint = depMkt
        ? ` Add "${depMkt}" to allowCrossMarketplaceDependenciesOn in the ROOT marketplace's marketplace.json (the marketplace of the plugin you're installing — only its allowlist applies; no transitive trust).`
        : ''
      return `Dependency "${r.dependency}" (required by ${r.requiredBy}) is in ${where}, which is not in the allowlist — cross-marketplace dependencies are blocked by default. Install it manually first.${hint}`
    }
    case 'not-found': {
      const { marketplace: depMkt } = parsePluginIdentifier(r.missing)
      return depMkt
        ? `Dependency "${r.missing}" (required by ${r.requiredBy}) not found. Is the "${depMkt}" marketplace added?`
        : `Dependency "${r.missing}" (required by ${r.requiredBy}) not found in any configured marketplace`
    }
  }
}

/**
 * Official 2.1.292 install rule for manifest `defaultEnabled`: a member with a
 * value in the target scope keeps it enabled unless it is `false` on a
 * disabled-by-default plugin; otherwise it is enabled when set in any settings
 * source, enabled by default, or (the root) required by an enabled dependent.
 * Dependencies of enabled members are then enabled too.
 */
function resolveClosureEnabled({
  closure,
  rootId,
  rootRequiredByDependent,
  priorEnabled,
  explicitAnywhere,
  defaultsById,
  dependenciesById,
}: {
  closure: readonly string[]
  rootId: string
  rootRequiredByDependent: boolean
  priorEnabled: Readonly<Record<string, unknown>>
  explicitAnywhere: ReadonlySet<string>
  defaultsById: ReadonlyMap<string, boolean>
  dependenciesById: ReadonlyMap<string, readonly string[]>
}): Map<string, boolean> {
  const members = new Set(closure)
  const enabled = new Set<string>()
  for (const id of closure) {
    const prior = priorEnabled[id]
    const byDefault = defaultsById.get(id) ?? true
    if (prior !== undefined) {
      if (prior !== false || byDefault) enabled.add(id)
      continue
    }
    if (
      explicitAnywhere.has(id) ||
      byDefault ||
      (id === rootId && rootRequiredByDependent)
    )
      enabled.add(id)
  }
  const pending = [...enabled]
  while (pending.length > 0) {
    for (const dep of dependenciesById.get(pending.pop()!) ?? []) {
      if (members.has(dep) && !enabled.has(dep)) {
        enabled.add(dep)
        pending.push(dep)
      }
    }
  }
  return new Map(closure.map(id => [id, enabled.has(id)]))
}

/**
 * Core plugin install logic, shared by the CLI path (`installPluginOp`) and
 * the interactive UI path (`installPluginFromMarketplace`). Given a
 * pre-resolved marketplace entry, this:
 *
 *   1. Guards against local-source plugins without a marketplace install
 *      location (would silently no-op otherwise).
 *   2. Resolves the transitive dependency closure (when PLUGIN_DEPENDENCIES
 *      is on; trivial single-plugin closure otherwise).
 *   3. Validates the source paths of the entire closure.
 *   4. Publishes and registers every closure member, then clears caches.
 *   5. Writes the closure's enabled state (honoring manifest defaultEnabled)
 *      in one settings update, restoring bytes on failure.
 *
 * Returns a structured result. Message formatting, analytics, and top-level
 * error wrapping stay in the caller-specific wrappers.
 *
 * @param marketplaceInstallLocation Pass this if the caller already has it
 *   (from a prior marketplace search) to avoid a redundant lookup.
 */
export async function installResolvedPlugin({
  pluginId,
  entry,
  scope,
  marketplaceInstallLocation,
  collisionSurface = 'cli',
}: {
  pluginId: string
  entry: PluginMarketplaceEntry
  scope: 'user' | 'project' | 'local'
  marketplaceInstallLocation?: string
  collisionSurface?: 'cli' | 'ui'
}): Promise<InstallCoreResult> {
  const settingSource = scopeToSettingSource(scope)

  // ── Policy guard ──
  // Org-blocked plugins (managed-settings.json enabledPlugins: false) cannot
  // be installed. Checked here so all install paths (CLI, UI, hint-triggered)
  // are covered in one place.
  if (isPluginBlockedByPolicy(pluginId)) {
    return { ok: false, reason: 'blocked-by-policy', pluginName: entry.name }
  }

  const recordRefusal = getInstalledPluginsReadRefusal()
  if (recordRefusal) {
    throw new Error(`Plugin "${pluginId}" was not installed: ${recordRefusal}`)
  }
  const installedPlugins = loadInstalledPluginsFromDisk().plugins
  const rootCollision = findPluginFolderCollision([pluginId], installedPlugins)
  if (rootCollision) throw new PluginFolderCollisionError(rootCollision, pluginId, collisionSurface)

  // ── Resolve dependency closure ──
  // depInfo caches marketplace lookups so the materialize loop doesn't
  // re-fetch. Seed the root if the caller gave us its install location.
  const depInfo = new Map<
    string,
    { entry: PluginMarketplaceEntry; marketplaceInstallLocation: string }
  >()
  // Without this guard, a local-source root with undefined
  // marketplaceInstallLocation falls through: depInfo isn't seeded, the
  // materialize loop's `if (!info) continue` skips the root, and the user
  // sees "Successfully installed" while nothing is cached.
  if (isLocalPluginSource(entry.source) && !marketplaceInstallLocation) {
    return {
      ok: false,
      reason: 'local-source-no-location',
      pluginName: entry.name,
    }
  }
  if (marketplaceInstallLocation) {
    depInfo.set(pluginId, { entry, marketplaceInstallLocation })
  }

  const rootMarketplace = parsePluginIdentifier(pluginId).marketplace
  const allowedCrossMarketplaces = new Set(
    (rootMarketplace
      ? (await getMarketplaceCacheOnly(rootMarketplace))
          ?.allowCrossMarketplaceDependenciesOn
      : undefined) ?? [],
  )
  const resolution = await resolveDependencyClosure(
    pluginId,
    async id => {
      if (depInfo.has(id)) return depInfo.get(id)!.entry
      if (id === pluginId) return entry
      const info = await getPluginById(id)
      if (info) depInfo.set(id, info)
      return info?.entry ?? null
    },
    getEnabledPluginIdsForScope(settingSource),
    allowedCrossMarketplaces,
  )
  if (!resolution.ok) {
    // @ts-ignore - recovered code
    return { ok: false, reason: 'resolution-failed', resolution }
  }
  const collision = findPluginFolderCollision(resolution.closure, installedPlugins)
  if (collision) {
    throw new PluginFolderCollisionError(collision, pluginId, collisionSurface, (installedPlugins[pluginId]?.length ?? 0) > 0)
  }

  // ── Policy guard for transitive dependencies ──
  // The root plugin was already checked above, but any dependency in the
  // closure could also be policy-blocked. Check before writing to settings
  // so a non-blocked plugin can't pull in a blocked dependency.
  for (const id of resolution.closure) {
    if (id !== pluginId && isPluginBlockedByPolicy(id)) {
      return {
        ok: false,
        reason: 'dependency-blocked-by-policy',
        pluginName: entry.name,
        blockedDependency: id,
      }
    }
  }

  // Validate the entire closure before materializing any member.
  const members: Array<{
    id: string
    entry: PluginMarketplaceEntry
    localSourcePath?: string
  }> = []
  for (const id of resolution.closure) {
    let info = depInfo.get(id)
    // Root wasn't pre-seeded (caller didn't pass marketplaceInstallLocation
    // for a non-local source). Fetch now; it's needed for the cache write.
    if (!info && id === pluginId) {
      const mktLocation = (await getPluginById(id))?.marketplaceInstallLocation
      info = { entry, marketplaceInstallLocation: mktLocation ?? '' }
    }
    if (!info)
      throw new Error(`Plugin ${id} is no longer available for installation`)

    let localSourcePath: string | undefined
    const { source } = info.entry
    if (isLocalPluginSource(source)) {
      try {
        localSourcePath = validatePathWithinBase(
          info.marketplaceInstallLocation,
          source,
        )
      } catch (error) {
        logForDebugging(
          `[Plugins:install] source path refused for ${id}: ${toError(error).message}`,
          { level: 'warn' },
        )
        throw new Error(
          `Cannot install ${id}: its marketplace entry path does not stay inside the marketplace directory (an absolute, climbing, network-shaped, backslash-containing or link-traversing entry, an entry of a fetched marketplace that resolves or opens outside its tree — or a relative entry in a url-catalog marketplace, which has no local directory)`,
          { cause: error },
        )
      }
    }
    members.push({ id, entry: info.entry, localSourcePath })
  }

  // Same project key that uninstall, update and relevance checks match on.
  const projectPath = scope !== 'user' ? getOriginalCwd() : undefined
  const manifests = new Map<string, PluginManifest>()
  for (const member of members) {
    const { manifest } = await cacheAndRegisterPlugin(
      member.id,
      member.entry,
      scope,
      projectPath,
      member.localSourcePath,
    )
    manifests.set(member.id, manifest)
  }

  const depNote = formatDependencyCountSuffix(
    resolution.closure.filter(id => id !== pluginId),
  )
  const priorEnabled = getSettingsForSource(settingSource)?.enabledPlugins ?? {}
  const mergedEnabled: Record<string, unknown> = {}
  for (const source of getEnabledSettingSources()) {
    Object.assign(mergedEnabled, getSettingsForSource(source)?.enabledPlugins)
  }
  const defaultsById = new Map<string, boolean>()
  const dependenciesById = new Map<string, string[]>()
  for (const member of members) {
    const manifest = manifests.get(member.id)
    defaultsById.set(
      member.id,
      member.entry.defaultEnabled ?? manifest?.defaultEnabled ?? true,
    )
    dependenciesById.set(
      member.id,
      [...(member.entry.dependencies ?? []), ...(manifest?.dependencies ?? [])]
        .map(dep => qualifyDependency(dep, member.id)),
    )
  }
  const explicitAnywhere = new Set(
    Object.keys(mergedEnabled).filter(id => mergedEnabled[id] !== undefined),
  )
  // Only consulted for a disabled-by-default root with no setting anywhere.
  let rootRequiredByDependent = false
  if (!explicitAnywhere.has(pluginId) && defaultsById.get(pluginId) === false) {
    const { enabled, disabled } = await loadAllPluginsCacheOnly()
    rootRequiredByDependent = [...enabled, ...disabled].some(p => {
      if (p.source === pluginId) return false
      const value = mergedEnabled[p.source]
      const active = value !== undefined
        ? value === true || Array.isArray(value)
        : p.manifest.defaultEnabled !== false
      return active && (p.manifest.dependencies ?? []).some(dep =>
        dependencyMatchesPlugin(qualifyDependency(dep, p.source), pluginId))
    })
  }
  const enabledById = resolveClosureEnabled({
    closure: resolution.closure,
    rootId: pluginId,
    rootRequiredByDependent,
    priorEnabled,
    explicitAnywhere,
    defaultsById,
    dependenciesById,
  })
  const closureEnabled: Record<string, boolean | string[]> = {}
  for (const id of resolution.closure) {
    const prior = priorEnabled[id]
    closureEnabled[id] = Array.isArray(prior) ? prior : enabledById.get(id) ?? true
  }
  // Snapshot immediately around this synchronous write so earlier cache work
  // cannot overwrite unrelated settings changes made while downloads run.
  const settingsPath = getSettingsFilePathForSource(settingSource)
  const fs = getFsImplementation()
  const readSnapshot = (): string | undefined => {
    if (!settingsPath) return undefined
    try {
      return fs.readFileSync(settingsPath, { encoding: 'utf8' })
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return undefined
      throw error
    }
  }
  const snapshot = readSnapshot()
  const restoreSnapshot = (error: unknown): void => {
    try {
      if (settingsPath && readSnapshot() !== snapshot) {
        if (snapshot === undefined) fs.unlinkSync(fs.realpathSync(settingsPath))
        else
          writeFileSyncAndFlush_DEPRECATED(settingsPath, snapshot, {
            encoding: 'utf-8',
            atomicOnly: true,
          })
        if (readSnapshot() !== snapshot)
          throw new Error('Settings snapshot restoration did not persist')
        resetSettingsCache()
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Plugin settings write and restoration failed: ${pluginId}`,
      )
    }
  }
  const { error } = updateSettingsForSource(
    settingSource,
    {
      enabledPlugins: {
        ...getSettingsForSource(settingSource)?.enabledPlugins,
        ...closureEnabled,
      },
    },
    { atomicOnly: true },
  )
  if (error) {
    restoreSnapshot(error)
    return {
      ok: false,
      reason: 'settings-write-failed',
      message: error.message,
    }
  }

  try {
    clearAllCaches()
  } catch (error) {
    restoreSnapshot(error)
    throw error
  }
  return { ok: true, closure: resolution.closure, depNote }
}

/**
 * Result of a plugin installation operation
 */
export type InstallPluginResult =
  | { readonly success: true; readonly message: string }
  | { readonly success: false; readonly error: string }

/**
 * Parameters for installing a plugin from marketplace
 */
export type InstallPluginParams = {
  pluginId: string
  entry: PluginMarketplaceEntry
  marketplaceName: string
  scope?: 'user' | 'project' | 'local'
  trigger?: 'hint' | 'user'
}

/**
 * Install a single plugin from a marketplace with the specified scope.
 * Interactive-UI wrapper around `installResolvedPlugin` — adds try/catch,
 * analytics, and UI-style message formatting.
 */
export async function installPluginFromMarketplace({
  pluginId,
  entry,
  marketplaceName,
  scope = 'user',
  trigger = 'user',
}: InstallPluginParams): Promise<InstallPluginResult> {
  try {
    // Look up the marketplace install location for local-source plugins.
    // Without this, plugins with relative-path sources fail from the
    // interactive UI path (/plugin install) even though the CLI path works.
    const pluginInfo = await getPluginById(pluginId)
    const marketplaceInstallLocation = pluginInfo?.marketplaceInstallLocation

    const result = await installResolvedPlugin({
      pluginId,
      entry,
      scope,
      marketplaceInstallLocation,
      collisionSurface: 'ui',
    })

    if (!result.ok) {
      // @ts-ignore - recovered code
      switch (result.reason) {
        case 'local-source-no-location':
          return {
            success: false,
            // @ts-ignore - recovered code
            error: `Cannot install local plugin "${result.pluginName}" without marketplace install location`,
          }
        case 'settings-write-failed':
          return {
            success: false,
            // @ts-ignore - recovered code
            error: `Failed to update settings: ${result.message}`,
          }
        case 'resolution-failed':
          return {
            success: false,
            // @ts-ignore - recovered code
            error: formatResolutionError(result.resolution),
          }
        case 'blocked-by-policy':
          return {
            success: false,
            // @ts-ignore - recovered code
            error: `Plugin "${result.pluginName}" is blocked by your organization's policy and cannot be installed`,
          }
        case 'dependency-blocked-by-policy':
          return {
            success: false,
            // @ts-ignore - recovered code
            error: `Cannot install "${result.pluginName}": dependency "${result.blockedDependency}" is blocked by your organization's policy`,
          }
      }
    }

    // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns.
    // plugin_id kept in additional_metadata (redacted to 'third-party' for
    // non-official) because dbt external_claude_code_plugin_installs.sql
    // extracts $.plugin_id for official-marketplace install tracking. Other
    // plugin lifecycle events drop the blob key — no downstream consumers.
    logEvent('tengu_plugin_installed', {
      _PROTO_plugin_name:
        entry.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      _PROTO_marketplace_name:
        marketplaceName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      plugin_id: (isOfficialMarketplaceName(marketplaceName)
        ? pluginId
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      trigger:
        trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      install_source: (trigger === 'hint'
        ? 'ui-suggestion'
        : 'ui-discover') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(
        entry.name,
        marketplaceName,
        getManagedPluginNames(),
      ),
      ...(entry.version && {
        version:
          entry.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })

    return {
      success: true,
      // @ts-ignore - recovered code
      message: `✓ Installed ${entry.name}${result.depNote}. Run /reload-plugins to activate.`,
    }
  } catch (err) {
    if (err instanceof PluginFolderCollisionError) {
      logForDebugging(`Plugin installation refused for ${pluginId}: ${err.message}`, { level: 'warn' })
      return { success: false, error: err.message }
    }
    const errorMessage = err instanceof Error ? err.message : String(err)
    logError(toError(err))
    return { success: false, error: `Failed to install: ${errorMessage}` }
  }
}
