import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

let sessionSettingsCache: SettingsWithErrors | null = null

export function getSessionSettingsCache(): SettingsWithErrors | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(value: SettingsWithErrors): void {
  sessionSettingsCache = value
}

/**
 * Per-source cache for getSettingsForSource. Invalidated alongside the
 * merged sessionSettingsCache — same resetSettingsCache() triggers
 * (settings write, --add-dir, plugin init, hooks refresh).
 */
const perSourceCache = new Map<SettingSource, SettingsJson | null>()

export function getCachedSettingsForSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  // undefined = cache miss; null = cached "no settings for this source"
  return perSourceCache.has(source) ? perSourceCache.get(source) : undefined
}

export function setCachedSettingsForSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value)
}

/**
 * Path-keyed cache for parseSettingsFile. Both getSettingsForSource and
 * loadSettingsFromDisk call parseSettingsFile on the same paths during
 * startup — this dedupes the disk read + zod parse.
 */
export type ParsedSettings = {
  settings: SettingsJson | null
  errors: ValidationError[]
  identity: string | null
}
const parseFileCache = new Map<string, ParsedSettings>()
// Only pending/blocked files need a last-accepted snapshot across cache resets.
const retainedFiles = new Map<string, ParsedSettings>()

// True while the change detector watches settings files and reviews outside
// edits (ConfigChange hooks) before the session applies them.
let outsideEditsReviewed = false

export function setOutsideEditsReviewed(value: boolean): void {
  outsideEditsReviewed = value
}

export function areOutsideEditsReviewed(): boolean {
  return outsideEditsReviewed
}

export function getCachedParsedFile(path: string): ParsedSettings | undefined {
  return retainedFiles.get(path) ?? parseFileCache.get(path)
}

export function retainSettingsFile(path: string): void {
  if (!retainedFiles.has(path)) {
    retainedFiles.set(
      path,
      parseFileCache.get(path) ?? {
        settings: null,
        errors: [],
        identity: null,
      },
    )
  }
}

export function isSettingsFileRetained(path: string): boolean {
  return retainedFiles.has(path)
}

export function releaseSettingsFile(path: string): void {
  retainedFiles.delete(path)
}

/** Retains `path` with this snapshot as what the session has accepted. */
export function retainSettingsSnapshot(path: string, value: ParsedSettings): void {
  retainedFiles.set(path, value)
  sessionSettingsCache = null
  perSourceCache.clear()
}

// Per path, the file version whose ConfigChange review was blocked.
const blockedCandidates = new Map<string, string | null>()

export function blockSettingsCandidate(path: string, identity: string | null): void {
  blockedCandidates.set(path, identity)
}

export function unblockSettingsCandidate(path: string): void {
  blockedCandidates.delete(path)
}

export function isBlockedSettingsCandidate(path: string, identity: string | null): boolean {
  return blockedCandidates.has(path) && blockedCandidates.get(path) === identity
}

export function clearBlockedSettingsCandidates(): void {
  blockedCandidates.clear()
}

export function getParsedSettingsPaths(): string[] {
  return [...new Set([...parseFileCache.keys(), ...retainedFiles.keys()])]
}

export function acceptSettingsFile(path: string, value: ParsedSettings): void {
  releaseSettingsFile(path)
  setCachedParsedFile(path, value)
  sessionSettingsCache = null
  perSourceCache.clear()
}

export function setCachedParsedFile(path: string, value: ParsedSettings): void {
  parseFileCache.set(path, value)
}

export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parseFileCache.clear()
}

/**
 * Plugin settings base layer for the settings cascade.
 * pluginLoader writes here after loading plugins;
 * loadSettingsFromDisk reads it as the lowest-priority base.
 */
let pluginSettingsBase: Record<string, unknown> | undefined

export function getPluginSettingsBase(): Record<string, unknown> | undefined {
  return pluginSettingsBase
}

export function setPluginSettingsBase(
  settings: Record<string, unknown> | undefined,
): void {
  pluginSettingsBase = settings
}

export function clearPluginSettingsBase(): void {
  pluginSettingsBase = undefined
}
