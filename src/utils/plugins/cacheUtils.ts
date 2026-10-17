import {
  cleanupPluginPublicationEntry,
  cleanupUninstalledPluginStaging,
  isPluginPublicationEntry,
} from './stagingDirectory.js'
import { constants, type Dirent, type Stats } from 'fs'
import { lstat, open, readdir, realpath, rmdir, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { clearCommandsCache } from '../../commands.js'
import { clearAllOutputStylesCache } from '../../constants/outputStyles.js'
import { clearAgentDefinitionsCache } from '../../tools/AgentTool/loadAgentsDir.js'
import { clearPromptCache } from '../../tools/SkillTool/prompt.js'
import { resetSentSkillNames } from '../attachments.js'
import { logForDebugging } from '../debug.js'
import { getErrnoCode } from '../errors.js'
import { logError } from '../log.js'
import { getInstalledPluginsFilePath, readInstalledPluginsForContractValidation } from './installedPluginsManager.js'
import { clearPluginAgentCache } from './loadPluginAgents.js'
import { clearPluginCommandCache } from './loadPluginCommands.js'
import {
  clearPluginHookCache,
  pruneRemovedPluginHooks,
} from './loadPluginHooks.js'
import { clearPluginOutputStyleCache } from './loadPluginOutputStyles.js'
import { clearPluginCache, getPluginCachePath } from './pluginLoader.js'
import { clearPluginOptionsCache } from './pluginOptionsStorage.js'
import { isPluginZipCacheEnabled } from './zipCache.js'
import type { LoadedPlugin } from '../../types/plugin.js'

// Hosts own these subscriptions; cache invalidation schedules work, while an
// explicit refresh supplies the already-loaded plugins and awaits activation.
const pluginRefreshListeners = new Set<
  (plugins?: readonly LoadedPlugin[]) => void | Promise<void>
>()

export function subscribePluginRefresh(
  listener: (plugins?: readonly LoadedPlugin[]) => void | Promise<void>,
): () => void {
  pluginRefreshListeners.add(listener)
  return () => { pluginRefreshListeners.delete(listener) }
}

export async function refreshPluginRuntimes(
  plugins: readonly LoadedPlugin[],
): Promise<void> {
  await Promise.all([...pluginRefreshListeners].map(listener => listener(plugins)))
}

const ORPHANED_AT_FILENAME = '.orphaned_at'
const CLEANUP_AGE_MS = 14 * 24 * 60 * 60 * 1000
const TEMP_FUTURE_ALLOWANCE_MS = 6 * 60 * 60 * 1000
const TEMP_CACHE_NAME = /^temp_(?:local|npm|github|git|subdir|archive|command|unknown)_(\d{10,})_[a-z0-9]{1,6}(?:_x|\.clone)?$/

export function clearAllPluginCaches(): void {
  clearPluginCache()
  clearPluginCommandCache()
  clearPluginAgentCache()
  clearPluginHookCache()
  // Prune hooks from plugins no longer in the enabled set so uninstalled/
  // disabled plugins stop firing immediately (gh-36995). Prune-only: hooks
  // from newly-enabled plugins are NOT added here — they wait for
  // /reload-plugins like commands/agents/MCP do. Fire-and-forget: old hooks
  // stay valid until the prune completes (preserves gh-29767). No-op when
  // STATE.registeredHooks is empty (test/preload.ts beforeEach clears it via
  // resetStateForTests before reaching here).
  pruneRemovedPluginHooks().catch(e => logError(e))
  clearPluginOptionsCache()
  clearPluginOutputStyleCache()
  clearAllOutputStylesCache()
  for (const listener of pluginRefreshListeners) {
    Promise.resolve(listener()).catch(error => logError(error))
  }
}

export function clearAllCaches(): void {
  clearAllPluginCaches()
  clearCommandsCache()
  clearAgentDefinitionsCache()
  clearPromptCache()
  resetSentSkillNames()
}

/** Mark an uninstalled or replaced version without following its marker. */
export async function markPluginVersionOrphaned(
  versionPath: string,
): Promise<void> {
  try {
    if ((await lstat(versionPath)).isSymbolicLink()) return
    if (!isWithin(await comparablePath(getPluginCachePath()), await comparablePath(versionPath))) {
      logForDebugging(`Not writing .orphaned_at outside the plugin cache root: ${versionPath}`)
      return
    }
    const marker = getOrphanedAtPath(versionPath)
    await prepareMarkerForWrite(marker)
    const noFollow = process.platform === 'win32'
      ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK
    const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o666)
    try { await file.writeFile(`${Date.now()}`, 'utf-8') } finally { await file.close() }
  } catch (error) {
    logForDebugging(`Failed to write .orphaned_at: ${versionPath}: ${error}`)
  }
}

/** Sweep filesystem versions after fourteen days, with bounded staging protection. */
export async function cleanupOrphanedPluginVersionsInBackground(): Promise<void> {
  try {
    const installedVersions = await getInstalledVersionPaths()
    const cachePath = getPluginCachePath()
    if (!installedVersions || installedVersions.length === 0) {
      if (!installedVersions) {
        try {await lstat(getInstalledPluginsFilePath());return}
        catch (error) {if(getErrnoCode(error)!=='ENOENT')throw error}
      }
      await cleanupUninstalledPluginStaging(cachePath, Date.now())
      return
    }
    const publicationReferences = new Set(installedVersions.map(entry=>resolve(entry.absolute)))
    if (isPluginZipCacheEnabled()) {
      await cleanupUninstalledPluginStaging(cachePath, Date.now(),publicationReferences)
      return
    }
    const cacheComparable = await comparablePath(cachePath)
    const installedKeys = new Set(installedVersions.flatMap(entry => [
      pathKey(entry.absolute), pathKey(entry.comparable),
    ]))
    const now = Date.now()

    await Promise.all(installedVersions
      .filter(entry => isWithin(cacheComparable, entry.comparable))
      .map(entry => removeOrphanedAtMarker(entry.absolute)))

    for (const marketplace of await readSubdirs(cachePath)) {
      const marketplacePath = join(cachePath, marketplace)
      const temporary = TEMP_CACHE_NAME.exec(marketplace)
      if (temporary) {
        const age = Date.now() - Number(temporary[1])
        if (age > -TEMP_FUTURE_ALLOWANCE_MS && age < CLEANUP_AGE_MS) {
          const stageComparable = await comparablePath(marketplacePath)
          const hasInstalledDescendant = installedVersions.some(entry =>
            isWithin(stageComparable, entry.comparable, false))
          if (!hasInstalledDescendant) continue
        }
      }
      for (const plugin of await readSubdirs(marketplacePath)) {
        const pluginPath = join(marketplacePath, plugin)
        for (const version of await readSubdirs(pluginPath)) {
          const versionPath = join(pluginPath, version)
          if (isPluginPublicationEntry(version)) {
            await cleanupPluginPublicationEntry(versionPath,now,publicationReferences)
            continue
          }
          if (installedKeys.has(pathKey(resolve(versionPath))) ||
            installedKeys.has(pathKey(await comparablePath(versionPath)))) continue
          await processOrphanedPluginVersion(versionPath, now)
        }
        await removeIfEmpty(pluginPath)
      }
      await removeIfEmpty(marketplacePath)
    }
  } catch (error) {
    logForDebugging(`Plugin cache cleanup failed: ${error}`)
  }
}

function getOrphanedAtPath(versionPath: string): string {
  return join(versionPath, ORPHANED_AT_FILENAME)
}

async function removeOrphanedAtMarker(versionPath: string): Promise<void> {
  try {
    if ((await lstat(versionPath)).isSymbolicLink()) return
    await unlink(getOrphanedAtPath(versionPath))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return
    logForDebugging(`Failed to remove .orphaned_at: ${versionPath}: ${error}`)
  }
}

async function getInstalledVersionPaths(): Promise<Array<{ absolute: string; comparable: string }> | null> {
  try {
    const diskData = readInstalledPluginsForContractValidation()
    const paths = new Set(Object.values(diskData.plugins).flatMap(entries =>
      entries.map(entry => entry.installPath)))
    return await Promise.all([...paths].map(async path => ({
      absolute: resolve(path), comparable: await comparablePath(path),
    })))
  } catch (error) {
    logForDebugging(`Failed to load installed plugins: ${error}`)
    return null
  }
}

// Canonicalize ordinary filesystem paths through their nearest existing ancestor.
// NFC and folded comparison keys match the local filesystem GC path comparison.
async function comparablePath(path: string): Promise<string> {
  let current = resolve(path)
  const tail: string[] = []
  let canonical: string
  while (true) {
    try { canonical = await realpath(current); break } catch {
      const parent = dirname(current)
      if (parent === current) { canonical = current; break }
      tail.unshift(basename(current))
      current = parent
    }
  }
  return join(canonical, ...tail).normalize('NFC').toLowerCase()
}

function pathKey(path: string): string {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return path
  return path.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toUpperCase().toLowerCase()
}

function isWithin(parent: string, child: string, allowSelf = true): boolean {
  const rel = relative(parent, child)
  return (allowSelf && rel === '') ||
    (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function prepareMarkerForWrite(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (entry.isFile()) {
      if (entry.nlink > 1) await unlink(path)
    } else if (entry.isSymbolicLink()) {
      await unlink(path)
    } else {
      await removeTreeNoFollow(path)
    }
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') throw error
  }
}

async function processOrphanedPluginVersion(versionPath: string, now: number): Promise<void> {
  const orphanedAtPath = getOrphanedAtPath(versionPath)
  let orphanedAt: number
  try {
    if ((await lstat(versionPath)).isSymbolicLink()) return
    const marker = await lstat(orphanedAtPath)
    if (!marker.isFile()) { await markPluginVersionOrphaned(versionPath); return }
    orphanedAt = marker.mtimeMs
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') { await markPluginVersionOrphaned(versionPath); return }
    logForDebugging(`Failed to stat orphaned marker: ${versionPath}: ${error}`)
    return
  }
  if (now - orphanedAt > CLEANUP_AGE_MS) {
    try { await removeTreeNoFollow(versionPath) } catch (error) {
      logForDebugging(`Failed to delete orphaned version: ${versionPath}: ${error}`)
    }
  }
}

function isUnknownEntry(entry: Dirent): boolean {
  return !entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink() &&
    !entry.isFIFO() && !entry.isSocket() && !entry.isBlockDevice() && !entry.isCharacterDevice()
}

async function removeIfEmpty(dirPath: string): Promise<void> {
  let entries: Dirent[]
  try {
    if (!(await lstat(dirPath)).isDirectory()) return
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    logForDebugging(`Failed to re-check dir before removal: ${dirPath}: ${error}`)
    return
  }
  if (entries.some(entry => entry.isDirectory() || entry.isSymbolicLink() ||
    isUnknownEntry(entry) || (entry.isFile() && /\.zip$/i.test(entry.name)))) return
  try { await removeTreeNoFollow(dirPath) } catch (error) {
    logForDebugging(`Failed to remove empty dir: ${dirPath}: ${error}`)
  }
}

async function removePathOrClassify(path: string): Promise<'removed' | 'absent' | 'directory'> {
  try { await unlink(path); return 'removed' } catch (unlinkError) {
    if (getErrnoCode(unlinkError) === 'ENOENT') return 'absent'
    try { await rmdir(path); return 'removed' } catch (directoryError) {
      const code = getErrnoCode(directoryError)
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'directory'
      if (code === 'ENOENT') {
        const absent = await lstat(path).then(() => false, error => getErrnoCode(error) === 'ENOENT')
        if (absent) return 'absent'
        throw unlinkError
      }
      throw code === 'ENOTDIR' ? unlinkError : directoryError
    }
  }
}

async function removeTreeNoFollow(path: string): Promise<void> {
  if (await removePathOrClassify(path) !== 'directory') return
  let entry: Stats
  try { entry = await lstat(path) } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return
    throw error
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) { await removePathOrClassify(path); return }
  let entries: string[]
  try { entries = await readdir(path) } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  for (let offset = 0; offset < entries.length; offset += 16) {
    await Promise.all(entries.slice(offset, offset + 16).map(name => removeTreeNoFollow(join(path, name))))
  }
  if (await removePathOrClassify(path) === 'directory') {
    throw Object.assign(new Error('directory refilled during removal'), { code: 'ENOTEMPTY', path })
  }
}

async function readSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const directories: string[] = []
    for (const entry of entries) {
      try {
        if (entry.isDirectory() || (isUnknownEntry(entry) && (await lstat(join(dirPath, entry.name))).isDirectory())) {
          directories.push(entry.name)
        }
      } catch (error) {
        logForDebugging(`Orphan sweep: skipping ${join(dirPath, entry.name)}: ${error}`)
      }
    }
    return directories
  } catch { return [] }
}
