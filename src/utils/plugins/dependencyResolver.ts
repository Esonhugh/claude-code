/**
 * Plugin dependency resolution — pure functions, no I/O.
 *
 * Semantics are `apt`-style: a dependency is a *presence guarantee*, not a
 * module graph. Plugin A depending on Plugin B means "B's namespaced
 * components (MCP servers, commands, agents) must be available when A runs."
 *
 * Two entry points:
 *  - `resolveDependencyClosure` — install-time DFS walk, cycle detection
 *  - `verifyAndDemote` — load-time fixed-point check, demotes plugins with
 *    unsatisfied deps (session-local, does NOT write settings)
 */

import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import type { PluginId } from './schemas.js'

/**
 * Synthetic marketplace sentinel for `--plugin-dir` plugins (pluginLoader.ts
 * sets `source = "{name}@inline"`). Not a real marketplace — bare deps from
 * these plugins cannot meaningfully inherit it.
 */
const INLINE_MARKETPLACE = 'inline'

/**
 * Normalize a dependency reference to fully-qualified "name@marketplace" form.
 * Bare names (no @) inherit the marketplace of the plugin declaring them —
 * cross-marketplace deps are blocked anyway, so the @-suffix is boilerplate
 * in the common case.
 *
 * EXCEPTION: if the declaring plugin is @inline (loaded via --plugin-dir),
 * bare deps are returned unchanged. `inline` is a synthetic sentinel, not a
 * real marketplace — fabricating "dep@inline" would never match anything.
 * verifyAndDemote handles bare deps via name-only matching.
 */
export function qualifyDependency(
  dep: string,
  declaringPluginId: string,
): string {
  if (parsePluginIdentifier(dep).marketplace) return dep
  const mkt = parsePluginIdentifier(declaringPluginId).marketplace
  if (!mkt || [INLINE_MARKETPLACE, 'skills-dir', 'synced'].includes(mkt)) return dep
  return `${dep}@${mkt}`
}

/** A session-local inline plugin can satisfy a marketplace-qualified dependency. */
export function dependencyMatchesPlugin(dependency: string, pluginId: string): boolean {
  const requested = parsePluginIdentifier(dependency), candidate = parsePluginIdentifier(pluginId)
  return requested.marketplace ? pluginId === dependency ||
    candidate.name === requested.name && candidate.marketplace === INLINE_MARKETPLACE : candidate.name === requested.name
}

/**
 * Minimal shape the resolver needs from a marketplace lookup. Keeping this
 * narrow means the resolver stays testable without constructing full
 * PluginMarketplaceEntry objects.
 */
export type DependencyLookupResult = {
  // Entries may be bare names; qualifyDependency normalizes them.
  dependencies?: string[]
}

export type ResolutionResult =
  | { ok: true; closure: PluginId[] }
  | { ok: false; reason: 'cycle'; chain: PluginId[] }
  | { ok: false; reason: 'not-found'; missing: PluginId; requiredBy: PluginId }
  | {
      ok: false
      reason: 'cross-marketplace'
      dependency: PluginId
      requiredBy: PluginId
    }

/**
 * Walk the transitive dependency closure of `rootId` via DFS.
 *
 * The returned `closure` ALWAYS contains `rootId`, plus every transitive
 * dependency that is NOT in `alreadyEnabled`. Already-enabled deps are
 * skipped (not recursed into) — this avoids surprise settings writes when a
 * dep is already installed at a different scope. The root is never skipped,
 * even if already enabled, so re-installing a plugin always re-caches it.
 *
 * Cross-marketplace dependencies are BLOCKED by default: a plugin in
 * marketplace A cannot auto-install a plugin from marketplace B. This is
 * a security boundary — installing from a trusted marketplace shouldn't
 * silently pull from an untrusted one. Two escapes: (1) install the
 * cross-mkt dep yourself first (already-enabled deps are skipped, so the
 * closure won't touch it), or (2) the ROOT marketplace's
 * `allowCrossMarketplaceDependenciesOn` allowlist — only the root's list
 * applies for the whole walk (no transitive trust: if A allows B, B's
 * plugin depending on C is still blocked unless A also allows C).
 *
 * @param rootId Root plugin to resolve from (format: "name@marketplace")
 * @param lookup Async lookup returning `{dependencies}` or `null` if not found
 * @param alreadyEnabled Plugin IDs to skip (deps only, root is never skipped)
 * @param allowedCrossMarketplaces Marketplace names the root trusts for
 *   auto-install (from the root marketplace's manifest)
 * @returns Closure to install, or a cycle/not-found/cross-marketplace error
 */
export async function resolveDependencyClosure(
  rootId: PluginId,
  lookup: (id: PluginId) => Promise<DependencyLookupResult | null>,
  alreadyEnabled: ReadonlySet<PluginId>,
  allowedCrossMarketplaces: ReadonlySet<string> = new Set(),
): Promise<ResolutionResult> {
  const rootMarketplace = parsePluginIdentifier(rootId).marketplace
  const closure: PluginId[] = []
  const visited = new Set<PluginId>()
  const stack: PluginId[] = []

  async function walk(
    id: PluginId,
    requiredBy: PluginId,
  ): Promise<ResolutionResult | null> {
    // Skip already-enabled DEPENDENCIES (avoids surprise settings writes),
    // but NEVER skip the root: installing an already-enabled plugin must
    // still cache/register it. Without this guard, re-installing a plugin
    // that's in settings but missing from disk (e.g., cache cleared,
    // installed_plugins.json stale) would return an empty closure and
    // `cacheAndRegisterPlugin` would never fire — user sees
    // "✔ Successfully installed" but nothing materializes.
    if (id !== rootId && alreadyEnabled.has(id)) return null
    // Security: block auto-install across marketplace boundaries. Runs AFTER
    // the alreadyEnabled check — if the user manually installed a cross-mkt
    // dep, it's in alreadyEnabled and we never reach this.
    const idMarketplace = parsePluginIdentifier(id).marketplace
    if (
      idMarketplace !== rootMarketplace &&
      !(idMarketplace && allowedCrossMarketplaces.has(idMarketplace))
    ) {
      return {
        ok: false,
        reason: 'cross-marketplace',
        dependency: id,
        requiredBy,
      }
    }
    if (stack.includes(id)) {
      return { ok: false, reason: 'cycle', chain: [...stack, id] }
    }
    if (visited.has(id)) return null
    visited.add(id)

    const entry = await lookup(id)
    if (!entry) {
      return { ok: false, reason: 'not-found', missing: id, requiredBy }
    }

    stack.push(id)
    for (const rawDep of entry.dependencies ?? []) {
      const dep = qualifyDependency(rawDep, id)
      const err = await walk(dep, id)
      if (err) return err
    }
    stack.pop()

    closure.push(id)
    return null
  }

  const err = await walk(rootId, rootId)
  if (err) return err
  return { ok: true, closure }
}

/**
 * Load-time safety net: for each enabled plugin, verify all manifest
 * dependencies are also in the enabled set. Demote any that fail.
 *
 * Fixed-point loop: demoting plugin A may break plugin B that depends on A,
 * so we iterate until nothing changes.
 *
 * The `reason` field distinguishes:
 *  - `'not-enabled'` — dep exists in the loaded set but is disabled
 *  - `'not-found'` — dep is entirely absent (not in any marketplace)
 *
 * Does NOT mutate input. Returns the set of plugin IDs (sources) to demote.
 *
 * @param plugins All loaded plugins (enabled + disabled)
 * @returns Set of pluginIds to demote, plus errors for `/doctor`
 */
export function verifyAndDemote(plugins: readonly LoadedPlugin[]): {
  demoted: Set<string>
  errors: PluginError[]
} {
  const known = new Set(plugins.map(p => p.source))
  const enabled = new Set(plugins.filter(p => p.enabled).map(p => p.source))
  // Name-only indexes for bare deps from --plugin-dir (@inline) plugins:
  // the real marketplace is unknown, so match "B" against any enabled "B@*".
  // enabledByName is a multiset: if B@epic AND B@other are both enabled,
  // demoting one mustn't make "B" disappear from the index.
  const knownByName = new Set(
    plugins.map(p => parsePluginIdentifier(p.source).name),
  )
  const enabledByName = new Map<string, number>()
  for (const id of enabled) {
    const n = parsePluginIdentifier(id).name
    enabledByName.set(n, (enabledByName.get(n) ?? 0) + 1)
  }
  const errors: PluginError[] = []

  let changed = true
  while (changed) {
    changed = false
    for (const p of plugins) {
      if (!enabled.has(p.source)) continue
      for (const rawDep of p.manifest.dependencies ?? []) {
        const dep = qualifyDependency(rawDep, p.source)
        // Bare dep ← @inline plugin: match by name only (see enabledByName)
        const isBare = !parsePluginIdentifier(dep).marketplace
        const satisfied = isBare
          ? (enabledByName.get(dep) ?? 0) > 0
          : enabled.has(dep) || enabled.has(`${parsePluginIdentifier(dep).name}@${INLINE_MARKETPLACE}`)
        if (!satisfied) {
          enabled.delete(p.source)
          const count = enabledByName.get(p.name) ?? 0
          if (count <= 1) enabledByName.delete(p.name)
          else enabledByName.set(p.name, count - 1)
          errors.push({
            type: 'dependency-unsatisfied',
            source: p.source,
            plugin: p.name,
            dependency: dep,
            reason: (isBare ? knownByName.has(dep) : known.has(dep) || known.has(`${parsePluginIdentifier(dep).name}@${INLINE_MARKETPLACE}`))
              ? 'not-enabled'
              : 'not-found',
          })
          changed = true
          break
        }
      }
    }
  }

  const demoted = new Set(
    plugins.filter(p => p.enabled && !enabled.has(p.source)).map(p => p.source),
  )
  return { demoted, errors }
}

/**
 * Find all enabled plugins that declare `pluginId` as a dependency.
 * Used to warn on uninstall/disable ("required by: X, Y").
 *
 * @param pluginId The plugin being removed/disabled
 * @param plugins All loaded plugins (only enabled ones are checked)
 * @returns Names of plugins that will break if `pluginId` goes away
 */
export function findReverseDependents(
  pluginId: PluginId,
  plugins: readonly LoadedPlugin[],
): string[] {
  return plugins
    .filter(
      p =>
        p.enabled &&
        p.source !== pluginId &&
        (p.manifest.dependencies ?? []).some(d => {
          const qualified = qualifyDependency(d, p.source)
          return dependencyMatchesPlugin(qualified, pluginId)
        }),
    )
    .map(p => p.name)
}

/**
 * Build the set of plugin IDs currently enabled at a given settings scope.
 * Used by install-time resolution to skip already-enabled deps and avoid
 * surprise settings writes.
 *
 * Matches `true` (plain enable) AND array values (version constraints per
 * settings/types.ts:455-463 — a plugin at `"foo@bar": ["^1.0.0"]` IS enabled).
 * Without the array check, a version-pinned dep would be re-added to the
 * closure and the settings write would clobber the constraint with `true`.
 */
export function getEnabledPluginIdsForScope(
  settingSource: EditableSettingSource,
): Set<PluginId> {
  return new Set(
    Object.entries(getSettingsForSource(settingSource)?.enabledPlugins ?? {})
      .filter(([, v]) => v === true || Array.isArray(v))
      .map(([k]) => k),
  )
}

const MAX_LISTED_DEPENDENCIES = 5

function listPluginNames(ids: readonly string[]): string {
  const names = ids
    .slice(0, MAX_LISTED_DEPENDENCIES)
    .map(id => parsePluginIdentifier(id).name)
    .join(', ')
  return ids.length <= MAX_LISTED_DEPENDENCIES ? names : `${names}, \u2026`
}

/**
 * Format the "(+ N dependencies: a, b)" suffix for install success messages.
 * Returns empty string when `installedDeps` is empty.
 */
export function formatDependencyCountSuffix(installedDeps: string[]): string {
  if (installedDeps.length === 0) return ''
  const n = installedDeps.length
  return ` (+ ${n} ${n === 1 ? 'dependency' : 'dependencies'}: ${listPluginNames(installedDeps)})`
}

/**
 * Official 2.1.329 `o0i`: the " — N dependencies still unresolved: …" suffix,
 * asking for the marketplace of the first one whose marketplace is not added.
 * Returns empty string when `unresolved` is empty.
 */
export function formatUnresolvedDependencySuffix(
  unresolved: readonly string[],
  marketplaceMissing: readonly string[],
): string {
  if (unresolved.length === 0) return ''
  const n = unresolved.length
  const marketplace = marketplaceMissing
    .map(id => parsePluginIdentifier(id).marketplace)
    .find(name => name !== undefined)
  const hint =
    marketplace !== undefined
      ? ` Is the "${marketplace}" marketplace added?`
      : marketplaceMissing.length > 0
        ? " Add the dependency's marketplace, then re-run install."
        : ''
  const listed = unresolved.slice(0, MAX_LISTED_DEPENDENCIES).join(', ')
  const names = n <= MAX_LISTED_DEPENDENCIES ? `${listed}.` : `${listed} and ${n - MAX_LISTED_DEPENDENCIES} more.`
  return ` \u2014 ${n} ${n === 1 ? 'dependency' : 'dependencies'} still unresolved: ${names}${hint}`
}

/**
 * Every enabled plugin that stops loading when `pluginId` goes away, as
 * plugin IDs, dependents of dependents first.
 */
export function findTransitiveReverseDependents(
  pluginId: PluginId,
  plugins: readonly LoadedPlugin[],
): PluginId[] {
  const seen = new Set([pluginId])
  const result: PluginId[] = []
  const visit = (id: PluginId): void => {
    for (const p of plugins) {
      if (
        !p.enabled ||
        seen.has(p.source) ||
        !(p.manifest.dependencies ?? []).some(d =>
          dependencyMatchesPlugin(qualifyDependency(d, p.source), id),
        )
      )
        continue
      seen.add(p.source)
      visit(p.source)
      result.push(p.source)
    }
  }
  visit(pluginId)
  return result
}

/**
 * Walk the dependencies of `pluginId` over the loaded plugins. `closure` holds
 * the installed dependencies (without the plugin itself), `missing` the ones
 * no loaded plugin provides.
 */
export function resolveEnableClosure(
  pluginId: PluginId,
  plugins: readonly LoadedPlugin[],
): { closure: PluginId[]; missing: PluginId[] } {
  const find = (id: string) =>
    plugins.find(p => p.source === id && p.enabled) ??
    plugins.find(p => p.source === id) ??
    plugins.find(p => p.enabled && dependencyMatchesPlugin(id, p.source)) ??
    plugins.find(p => dependencyMatchesPlugin(id, p.source))
  const closure: PluginId[] = []
  const missing: PluginId[] = []
  const root = find(pluginId)
  const seen = new Set([pluginId, ...(root ? [root.source] : [])])
  const queue = (root?.manifest.dependencies ?? []).map(d =>
    qualifyDependency(d, root!.source),
  )
  for (let dep = queue.shift(); dep !== undefined; dep = queue.shift()) {
    const found = find(dep)
    if (!found) {
      if (!seen.has(dep)) {
        seen.add(dep)
        missing.push(dep)
      }
      continue
    }
    if (seen.has(found.source)) continue
    seen.add(found.source)
    closure.push(found.source)
    for (const d of found.manifest.dependencies ?? [])
      queue.push(qualifyDependency(d, found.source))
  }
  return { closure, missing }
}

/**
 * Auto-installed dependencies at `scope` that no manually installed plugin at
 * that scope still reaches. When a recorded plugin did not load, its
 * dependencies are unknown and nothing is reported as orphaned.
 */
export function findOrphanedAutoDependencies(
  installed: Record<
    string,
    readonly { scope: string; projectPath?: string; auto?: boolean }[]
  >,
  plugins: readonly LoadedPlugin[],
  scope: string,
  projectPath?: string,
): { orphans: PluginId[]; unloadable: PluginId[]; autoCount: number } {
  const manual: PluginId[] = []
  const auto: PluginId[] = []
  for (const [id, records] of Object.entries(installed)) {
    const record = records.find(
      r => r.scope === scope && r.projectPath === projectPath,
    )
    if (record) (record.auto === true ? auto : manual).push(id)
  }
  if (auto.length === 0) return { orphans: [], unloadable: [], autoCount: 0 }
  const bySource = new Map(plugins.map(p => [p.source, p]))
  const unloadable = [...manual, ...auto].filter(id => !bySource.has(id))
  if (unloadable.length > 0)
    return { orphans: [], unloadable, autoCount: auto.length }
  const needed = new Set<PluginId>()
  const mark = (id: PluginId): void => {
    if (needed.has(id)) return
    needed.add(id)
    const p = bySource.get(id)
    for (const d of p?.manifest.dependencies ?? [])
      mark(qualifyDependency(d, p!.source))
  }
  manual.forEach(mark)
  return {
    orphans: auto.filter(id => !needed.has(id)),
    unloadable: [],
    autoCount: auto.length,
  }
}

/** Line appended to an uninstall result when it left orphaned dependencies. */
export function formatOrphanedDependenciesNote(
  orphans: readonly PluginId[],
  scope: string,
): string {
  if (orphans.length === 0) return ''
  const n = orphans.length
  return `\n${n} auto-installed ${n === 1 ? 'dependency' : 'dependencies'} no longer needed: ${listPluginNames(orphans)}. Run \`claude plugin prune${scope === 'user' ? '' : ` --scope ${scope}`}\` to remove.`
}

/**
 * Format the "warning: required by X, Y" suffix for uninstall/disable
 * results. Em-dash style for CLI result messages (not the middot style
 * used in the notification UI). Returns empty string when no dependents.
 */
export function formatReverseDependentsSuffix(
  rdeps: string[] | undefined,
): string {
  if (!rdeps || rdeps.length === 0) return ''
  return ` — warning: required by ${rdeps.join(', ')}`
}
