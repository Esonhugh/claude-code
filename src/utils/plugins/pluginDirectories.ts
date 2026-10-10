/**
 * Centralized plugin directory configuration.
 *
 * This module provides the single source of truth for the plugins directory path.
 * It supports switching between 'plugins' and 'cowork_plugins' directories via:
 * - CLI flag: --cowork
 * - Environment variable: CLAUDE_CODE_USE_COWORK_PLUGINS
 *
 * The base directory can be overridden via CLAUDE_CODE_PLUGIN_CACHE_DIR.
 */

import { mkdirSync } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import { delimiter, isAbsolute, join, resolve, win32 } from 'path'
import { getUseCoworkPlugins } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { errorMessage, isFsInaccessible } from '../errors.js'
import { formatFileSize } from '../format.js'
import { expandTilde } from '../path.js'

const PLUGINS_DIR = 'plugins'
const COWORK_PLUGINS_DIR = 'cowork_plugins'

/**
 * Get the plugins directory name based on current mode.
 * Uses session state (from --cowork flag) or env var.
 *
 * Priority:
 * 1. Session state (set by CLI flag --cowork)
 * 2. Environment variable CLAUDE_CODE_USE_COWORK_PLUGINS
 * 3. Default: 'plugins'
 */
function getPluginsDirectoryName(): string {
  // Session state takes precedence (set by CLI flag)
  if (getUseCoworkPlugins()) {
    return COWORK_PLUGINS_DIR
  }
  // Fall back to env var
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)) {
    return COWORK_PLUGINS_DIR
  }
  return PLUGINS_DIR
}

/**
 * Get the full path to the plugins directory.
 *
 * Priority:
 * 1. CLAUDE_CODE_PLUGIN_CACHE_DIR env var (explicit override)
 * 2. Default: ~/.claude/plugins or ~/.claude/cowork_plugins
 */
export function getPluginsDirectory(): string {
  // expandTilde: when CLAUDE_CODE_PLUGIN_CACHE_DIR is set via settings.json
  // `env` (not shell), ~ is not expanded by the shell. Without this, a value
  // like "~/.claude/plugins" becomes a literal `~` directory created in the
  // cwd of every project (gh-30794 / CC-212).
  const envOverride = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  if (envOverride) {
    return expandTilde(envOverride)
  }
  return join(getClaudeConfigHomeDir(), getPluginsDirectoryName())
}

/**
 * Get the read-only plugin seed directories, if configured.
 *
 * Customers can pre-bake a populated plugins directory into their container
 * image and point CLAUDE_CODE_PLUGIN_SEED_DIR at it. CC will use it as a
 * read-only fallback layer under the primary plugins directory — marketplaces
 * and plugin caches found in the seed are used in place without re-cloning.
 *
 * Multiple seed directories can be layered using the platform path delimiter
 * (':' on Unix, ';' on Windows), in PATH-like precedence order — the first
 * seed that contains a given marketplace or plugin cache wins.
 *
 * Seed structure mirrors the primary plugins directory:
 *   $CLAUDE_CODE_PLUGIN_SEED_DIR/
 *     known_marketplaces.json
 *     marketplaces/<name>/...
 *     cache/<marketplace>/<plugin>/<version>/...
 *
 * @returns Absolute paths to seed dirs in precedence order (empty if unset)
 */
export function getPluginSeedDirs(): string[] {
  // Same tilde-expansion rationale as getPluginsDirectory (gh-30794).
  const raw = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  if (!raw) return []
  return raw.split(delimiter).filter(Boolean).map(expandTilde)
}

// Check before resolve(): normalizing /net/server/../.. first would hide
// the network location that official 2.1.292 refuses to load from env.
function isLocalPluginDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false
  const hasTraversal = (value: string) => /(^|[\\/])\.{1,2}[. ]*([\\/]|$)/.test(value)
  if (/^\\\\\?\\volume\{/i.test(path)) return !hasTraversal(path) && !path.includes('/')
  const devicePrefix = /^[\\/]\?\?[\\/]/
  if (devicePrefix.test(path) || (path.includes('??') && devicePrefix.test(win32.normalize(path)))) return false
  const windowsPath = path.startsWith('\\\\?\\UNC\\')
    ? '\\\\' + path.slice(8)
    : path.startsWith('\\\\?\\') && path.length >= 7 && path[5] === ':' ? path.slice(4) : path
  if (windowsPath !== path && (hasTraversal(windowsPath) || windowsPath.includes('/'))) return false
  const wslShare = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]*)/i.exec(windowsPath)
  const isWslShare = wslShare !== null && !/^\.{0,2}[. ]*$/.test(wslShare[1] ?? '')
  if (/^[\\/]{2}/.test(windowsPath) && !isWslShare) return false

  if (path.startsWith('/')) {
    const parts: string[] = []
    const fold = (part: string) => part.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toUpperCase().toLowerCase()
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') { parts.pop(); continue }
      parts.push(part)
      if (parts.length === 1 && parts[0]!.toLowerCase() === 'network') return false
      if (parts.length === 2 && fold(parts[0]!) === 'net') return false
      if (parts.length === 3 && fold(parts[0]!) === 'network' && fold(parts[1]!) === 'servers') return false
    }
  }
  return true
}

export function getPluginDirsFromEnvironment(raw = process.env.CLAUDE_CODE_PLUGIN_DIRS): string[] {
  const paths = (raw ?? '').split(delimiter).map(path => expandTilde(path.trim())).filter(Boolean)
  const invalid = paths.filter(path => !isLocalPluginDirectory(path))
  if (invalid.length > 0) {
    logForDebugging(`CLAUDE_CODE_PLUGIN_DIRS: skipped ${invalid.join(', ')}: a plugin folder here is an absolute local path or starts with ~`, { level: 'warn' })
  }
  return paths.filter(isLocalPluginDirectory).map(path => resolve(path))
}

export function settlePluginDirsEnvironment(): string[] {
  const paths = getPluginDirsFromEnvironment()
  if (process.env.CLAUDE_CODE_PLUGIN_DIRS !== undefined) {
    process.env.CLAUDE_CODE_PLUGIN_DIRS = paths.join(delimiter)
  }
  return paths
}

export function mergePluginDirectories(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const paths = new Map<string, string>()
  for (const path of groups.flat()) {
    const key = resolve(path)
    if (!paths.has(key)) paths.set(key, path)
  }
  return [...paths.values()]
}

function sanitizePluginId(pluginId: string): string {
  const npmName = pluginId.slice(0, -4)
  if (pluginId.endsWith('@npm') && !npmName.includes('..') &&
      /^(?:@[a-z0-9][a-z0-9-._]*\/)?[a-z0-9][a-z0-9-._]*$/.test(npmName)) {
    return `${npmName.replace(/[^a-z0-9-]/gu, char => {
      const code = char.codePointAt(0)!
      return code <= 255 ? `_${code.toString(16).padStart(2, '0')}` : `__${code.toString(16)}_`
    })}-npm`
  }
  // Same character class as the install-cache sanitizer (pluginLoader.ts)
  return pluginId.replace(/[^a-zA-Z0-9\-_]/g, '-')
}

/** Pure path — no mkdir. For display (e.g. uninstall dialog). */
export function pluginDataDirPath(pluginId: string): string {
  return join(getPluginsDirectory(), 'data', sanitizePluginId(pluginId))
}

/**
 * Persistent per-plugin data directory, exposed to plugins as
 * ${CLAUDE_PLUGIN_DATA}. Unlike the version-scoped install cache
 * (${CLAUDE_PLUGIN_ROOT}, which is orphaned and GC'd on every update),
 * this survives plugin updates — only removed on last-scope uninstall.
 *
 * Creates the directory on call (mkdir). The *lazy* behavior is at the
 * substitutePluginVariables call site — the DATA pattern uses function-form
 * .replace() so this isn't invoked unless ${CLAUDE_PLUGIN_DATA} is present
 * (ROOT also uses function-form, but for $-pattern safety, not laziness).
 * Env-var export sites (MCP/LSP server env, hook env) call this eagerly
 * since subprocesses may expect the dir to exist before writing to it.
 *
 * Sync because it's called from substitutePluginVariables (sync, inside
 * String.replace) — making this async would cascade through 6 call sites
 * and their sync iteration loops. One mkdir in plugin-load path is cheap.
 */
export function getPluginDataDir(pluginId: string): string {
  const dir = pluginDataDirPath(pluginId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Size of the data dir for the uninstall confirmation prompt. Returns null
 * when the dir is absent or empty so callers can skip the prompt entirely.
 * Recursive walk — not hot-path (only on uninstall).
 */
export async function getPluginDataDirSize(
  pluginId: string,
): Promise<{ bytes: number; human: string } | null> {
  const dir = pluginDataDirPath(pluginId)
  let bytes = 0
  const walk = async (p: string) => {
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        // Per-entry catch: a broken symlink makes stat() throw ENOENT.
        // Without this, one broken link bubbles to the outer catch →
        // returns null → dialog skipped → data silently deleted.
        try {
          bytes += (await stat(full)).size
        } catch {
          // Broken symlink / raced delete — skip this entry, keep walking
        }
      }
    }
  }
  try {
    await walk(dir)
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
  if (bytes === 0) return null
  return { bytes, human: formatFileSize(bytes) }
}

/**
 * Best-effort cleanup on last-scope uninstall. Failure is logged but does
 * not throw — the uninstall itself already succeeded; we don't want a
 * cleanup side-effect surfacing as "uninstall failed". Same rationale as
 * deletePluginOptions (pluginOptionsStorage.ts).
 */
export async function deletePluginDataDir(
  pluginId: string,
  remainingPluginIds: Iterable<string> | null,
): Promise<void> {
  const dir = pluginDataDirPath(pluginId)
  if (remainingPluginIds === null) {
    logForDebugging(`Keeping plugin data dir ${dir}: installed plugin records cannot be read`, { level: 'warn' })
    return
  }
  for (const other of remainingPluginIds) {
    if (other !== pluginId && pluginDataDirPath(other).toLowerCase() === dir.toLowerCase()) {
      logForDebugging(`Keeping plugin data dir ${dir}: still used by ${other}`)
      return
    }
  }
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    logForDebugging(
      `Failed to delete plugin data dir ${dir}: ${errorMessage(e)}`,
      { level: 'warn' },
    )
  }
}
