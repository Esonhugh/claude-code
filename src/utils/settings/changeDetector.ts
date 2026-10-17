import chokidar, { type FSWatcher } from 'chokidar'
import { readdir, realpath, stat } from 'fs/promises'
import * as platformPath from 'path'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import {
  type ConfigChangeSource,
  executeConfigChangeHooks,
  hasBlockingResult,
} from '../hooks.js'
import { createSignal } from '../signal.js'
import { jsonStringify } from '../slowOperations.js'
import { SETTING_SOURCES, type SettingSource } from './constants.js'
import { clearInternalWrites, consumeInternalWrite } from './internalWrites.js'
import { getManagedSettingsDropInDir } from './managedPath.js'
import {
  getHkcuSettings,
  getMdmSettings,
  refreshMdmSettings,
  setMdmSettingsCache,
} from './mdm/settings.js'
import {
  getInitialSettings,
  getSettingsFilePathForSource,
  readSettingsFile,
} from './settings.js'
import {
  acceptSettingsFile,
  getCachedParsedFile,
  getParsedSettingsPaths,
  releaseSettingsFile,
  resetSettingsCache,
  retainSettingsFile,
} from './settingsCache.js'

/**
 * Time in milliseconds to wait for file writes to stabilize before processing.
 * This helps avoid processing partial writes or rapid successive changes.
 */
const FILE_STABILITY_THRESHOLD_MS = 1000

/**
 * Polling interval in milliseconds for checking file stability.
 * Used by chokidar's awaitWriteFinish option.
 * Must be lower than FILE_STABILITY_THRESHOLD_MS.
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 500

/**
 * Retention window for internal-write identities, not a suppression window.
 * A callback is suppressed only when its current bytes match the write.
 */
const INTERNAL_WRITE_WINDOW_MS = 5000

/**
 * Poll interval for MDM settings (registry/plist) changes.
 * These can't be watched via filesystem events, so we poll periodically.
 */
const MDM_POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Grace period in milliseconds before processing a settings file deletion.
 * Handles the common delete-and-recreate pattern during auto-updates or when
 * another session starts up. If an `add` or `change` event fires within this
 * window (file was recreated), the deletion is cancelled and treated as a change.
 *
 * Must exceed chokidar's awaitWriteFinish delay (stabilityThreshold + pollInterval)
 * so the grace window outlasts the write stability check on the recreated file.
 */
const DELETION_GRACE_MS =
  FILE_STABILITY_THRESHOLD_MS + FILE_STABILITY_POLL_INTERVAL_MS + 200

let watcher: FSWatcher | null = null
let mdmPollTimer: ReturnType<typeof setInterval> | null = null
let lastMdmSnapshot: string | null = null
let initialized = false
let disposed = false
let lifecycle = 0
let watchedPathAliases = new Map<string, string>()
const pendingReviews = new Map<string, Promise<void>>()
const blockedIdentities = new Map<string, string | null>()
const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>()
const settingsChanged = createSignal<[source: SettingSource]>()

// Test overrides for timing constants
let testOverrides: {
  stabilityThreshold?: number
  pollInterval?: number
  mdmPollInterval?: number
  deletionGrace?: number
} | null = null

/**
 * Initialize file watching
 */
export async function initialize(): Promise<void> {
  if (getIsRemoteMode()) return
  if (initialized || disposed) return
  initialized = true
  const generation = lifecycle

  // Prime the existing parsed cache before external events can arrive.
  getInitialSettings()

  // Start MDM poll for registry/plist changes (independent of filesystem watching)
  startMdmPoll()

  // Register cleanup to properly dispose during graceful shutdown
  registerCleanup(dispose)

  const { dirs, settingsFiles, dropInDir } = await getWatchTargets()
  if (disposed || generation !== lifecycle) return // closed during the await
  if (dirs.length === 0) return

  const watchedPaths = new Set(dirs)
  const aliases = new Map<string, string>()
  for (const path of settingsFiles) {
    aliases.set(platformPath.normalize(path), path)
    try {
      aliases.set(platformPath.normalize(await realpath(path)), path)
    } catch {
      // The file may disappear between discovery and watcher setup.
    }
  }
  for (const dir of dirs) {
    try {
      watchedPaths.add(await realpath(dir))
    } catch {
      // The directory may disappear between discovery and watcher setup.
    }
  }
  watchedPathAliases = aliases

  logForDebugging(
    `Watching for changes in setting files ${[...settingsFiles].join(', ')}...${dropInDir ? ` and drop-in directory ${dropInDir}` : ''}`,
  )

  watcher = chokidar.watch([...watchedPaths], {
    persistent: true,
    ignoreInitial: true,
    depth: 0, // Only watch immediate children, not subdirectories
    awaitWriteFinish: {
      stabilityThreshold:
        testOverrides?.stabilityThreshold ?? FILE_STABILITY_THRESHOLD_MS,
      pollInterval:
        testOverrides?.pollInterval ?? FILE_STABILITY_POLL_INTERVAL_MS,
    },
    ignored: (path, stats) => {
      // Ignore special file types (sockets, FIFOs, devices) - they cannot be watched
      // and will error with EOPNOTSUPP on macOS.
      if (stats && !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink()) {
        return true
      }
      // Ignore .git directories
      if (path.split(platformPath.sep).some(dir => dir === '.git')) return true
      // Allow directories (chokidar needs them for directory-level watching)
      // and paths without stats (chokidar's initial check before stat)
      if (!stats || stats.isDirectory()) return false
      // Only watch known settings files, ignore everything else in the directory
      // Note: chokidar normalizes paths to forward slashes on Windows, so we
      // normalize back to native format for comparison
      const normalized = platformPath.normalize(path)
      if (settingsFiles.has(normalized)) return false
      // Also accept .json files inside the managed-settings.d/ drop-in directory
      if (
        dropInDir &&
        normalized.startsWith(dropInDir + platformPath.sep) &&
        normalized.endsWith('.json')
      ) {
        return false
      }
      return true
    },
    // Additional options for stability
    ignorePermissionErrors: true,
    usePolling: false, // Use native file system events
    atomic: true, // Handle atomic writes better
  })

  watcher.on('change', handleChange)
  watcher.on('unlink', handleDelete)
  watcher.on('add', handleAdd)
  watcher.once('ready', () => {
    if (!disposed) logForDebugging('Settings watcher ready (native events)')
  })
}

/**
 * Clean up file watcher. Returns a promise that resolves when chokidar's
 * close() settles — callers that need the watcher fully stopped before
 * removing the watched directory (e.g. test teardown) must await this.
 * Fire-and-forget is still valid where timing doesn't matter.
 */
export function dispose(): Promise<void> {
  disposed = true
  lifecycle++
  if (mdmPollTimer) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  lastMdmSnapshot = null
  watchedPathAliases.clear()
  clearInternalWrites()
  settingsChanged.clear()
  const w = watcher
  watcher = null
  return w ? w.close() : Promise.resolve()
}

/**
 * Subscribe to settings changes
 */
export const subscribe = settingsChanged.subscribe

/**
 * Collect settings file paths and their deduplicated parent directories to watch.
 * Returns all potential settings file paths for watched directories, not just those
 * that exist at init time, so that newly-created files are also detected.
 */
async function getWatchTargets(): Promise<{
  dirs: string[]
  settingsFiles: Set<string>
  dropInDir: string | null
}> {
  // Map from directory to all potential settings files in that directory
  const dirToSettingsFiles = new Map<string, Set<string>>()
  const dirsWithExistingFiles = new Set<string>()

  for (const source of SETTING_SOURCES) {
    // Skip flagSettings - they're provided via CLI and won't change during the session.
    // Additionally, they may be temp files in $TMPDIR which can contain special files
    // (FIFOs, sockets) that cause the file watcher to hang or error.
    // See: https://github.com/anthropics/claude-code/issues/16469
    if (source === 'flagSettings') {
      continue
    }
    const path = getSettingsFilePathForSource(source)
    if (!path) {
      continue
    }

    const dir = platformPath.dirname(path)

    // Track all potential settings files in each directory
    if (!dirToSettingsFiles.has(dir)) {
      dirToSettingsFiles.set(dir, new Set())
    }
    dirToSettingsFiles.get(dir)!.add(path)

    // Check if file exists - only watch directories that have at least one existing file
    try {
      const stats = await stat(path)
      if (stats.isFile()) {
        dirsWithExistingFiles.add(dir)
      }
    } catch {
      // File doesn't exist, that's fine
    }
  }

  // For watched directories, include ALL potential settings file paths
  // This ensures files created after init are also detected
  const settingsFiles = new Set<string>()
  for (const dir of dirsWithExistingFiles) {
    const filesInDir = dirToSettingsFiles.get(dir)
    if (filesInDir) {
      for (const file of filesInDir) {
        settingsFiles.add(file)
      }
    }
  }

  // Also watch the managed-settings.d/ drop-in directory for policy fragments.
  // We add it as a separate watched directory so chokidar's depth:0 watches
  // its immediate children (the .json files). Any .json file inside it maps
  // to the 'policySettings' source.
  let dropInDir: string | null = null
  const managedDropIn = getManagedSettingsDropInDir()
  try {
    const stats = await stat(managedDropIn)
    if (stats.isDirectory()) {
      dirsWithExistingFiles.add(managedDropIn)
      dropInDir = managedDropIn
    }
  } catch {
    // Drop-in directory doesn't exist, that's fine
  }

  return { dirs: [...dirsWithExistingFiles], settingsFiles, dropInDir }
}

function settingSourceToConfigChangeSource(
  source: SettingSource,
): ConfigChangeSource {
  switch (source) {
    case 'userSettings':
      return 'user_settings'
    case 'projectSettings':
      return 'project_settings'
    case 'localSettings':
      return 'local_settings'
    case 'flagSettings':
    case 'policySettings':
      return 'policy_settings'
  }
}

function handleChange(path: string): void {
  path = getConfiguredPath(path)
  const source = getSourceForPath(path)
  if (!source) return

  // If a deletion was pending for this path (delete-and-recreate pattern),
  // cancel the deletion — we'll process this as a change instead.
  const pendingTimer = pendingDeletions.get(path)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingDeletions.delete(path)
    logForDebugging(
      `Cancelled pending deletion of ${path} — file was recreated`,
    )
  }

  void reviewSettingsFile(path, source).catch(error => {
    logForDebugging(`Settings review failed for ${path}: ${errorMessage(error)}`)
  })
}

/**
 * Handle a file being re-added (e.g. after a delete-and-recreate). Cancels any
 * pending deletion grace timer and treats the event as a change.
 */
function handleAdd(path: string): void {
  path = getConfiguredPath(path)
  const source = getSourceForPath(path)
  if (!source) return

  // Cancel any pending deletion — the file is back
  const pendingTimer = pendingDeletions.get(path)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingDeletions.delete(path)
    logForDebugging(`Cancelled pending deletion of ${path} — file was re-added`)
  }

  // Treat as a change (re-read settings)
  handleChange(path)
}

/**
 * Handle a file being deleted. Uses a grace period to absorb delete-and-recreate
 * patterns (e.g. auto-updater, another session starting up). If the file is
 * recreated within the grace period (detected via 'add' or 'change' event),
 * the deletion is cancelled and treated as a normal change instead.
 */
function handleDelete(path: string): void {
  path = getConfiguredPath(path)
  const source = getSourceForPath(path)
  if (!source) return

  logForDebugging(`Detected deletion of ${path}`)

  // If there's already a pending deletion for this path, let it run
  if (pendingDeletions.has(path)) return

  const timer = setTimeout(
    (p, src) => {
      pendingDeletions.delete(p)

      void reviewSettingsFile(p, src).catch(error => {
        logForDebugging(`Settings deletion review failed for ${p}: ${errorMessage(error)}`)
      })
    },
    testOverrides?.deletionGrace ?? DELETION_GRACE_MS,
    path,
    source,
  )
  pendingDeletions.set(path, timer)
}

/** Explicit reload and watcher callbacks share the same review/publication path. */
export async function refreshSettings(): Promise<void> {
  if (disposed || getIsRemoteMode()) return
  const generation = lifecycle
  const inFlight = new Map(pendingReviews)
  const paths = new Set(getParsedSettingsPaths())
  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const path = getSettingsFilePathForSource(source)
    if (path) paths.add(path)
  }
  const dropInDir = getManagedSettingsDropInDir()
  try {
    for (const name of await readdir(dropInDir)) {
      if (name.endsWith('.json') && !name.startsWith('.')) {
        paths.add(platformPath.join(dropInDir, name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (disposed || generation !== lifecycle) return
  // Retain all candidates before the first hook. A hook or a listener
  // may reset derived caches while another file is still awaiting review.
  for (const path of paths) {
    const source = getSourceForPath(path)
    if (source && source !== 'flagSettings') retainSettingsFile(path)
  }
  for (const path of paths) {
    const source = getSourceForPath(path)
    if (source && source !== 'flagSettings') {
      const pending = inFlight.get(path)
      if (pending) await pending
      await reviewSettingsFile(path, source, !pending)
    }
  }
}

function reviewSettingsFile(
  path: string,
  source: SettingSource,
  retryBlocked = false,
): Promise<void> {
  if (disposed) return Promise.resolve()
  const pending = pendingReviews.get(path)
  if (pending) return pending
  retainSettingsFile(path)
  const generation = lifecycle
  const review = (async () => {
    // Register the in-flight operation before executing user hooks.
    await Promise.resolve()
    while (!disposed && generation === lifecycle) {
      // A synchronous internal write may have accepted a newer snapshot while
      // the previous hook awaited; protect that snapshot for this next review.
      retainSettingsFile(path)
      const candidate = readSettingsFile(path)
      const internal = consumeInternalWrite(
        path,
        candidate.identity,
        INTERNAL_WRITE_WINDOW_MS,
      )
      if (candidate.identity === getCachedParsedFile(path)?.identity) {
        blockedIdentities.delete(path)
        acceptSettingsFile(path, candidate)
        return
      }
      if (
        !internal && !retryBlocked && blockedIdentities.has(path) &&
        blockedIdentities.get(path) === candidate.identity
      ) return
      if (!internal) {
        logForDebugging(`Reviewing settings source=${source} path=${path} version=${candidate.identity}`)
        const results = await executeConfigChangeHooks(
          settingSourceToConfigChangeSource(source),
          path,
        )
        if (disposed || generation !== lifecycle) return
        // Approval belongs to these bytes, never the next write during an await.
        if (readSettingsFile(path).identity !== candidate.identity) continue
        if (hasBlockingResult(results)) {
          blockedIdentities.set(path, candidate.identity)
          logForDebugging(`ConfigChange blocked source=${source} path=${path} version=${candidate.identity}`)
          return
        }
      }
      blockedIdentities.delete(path)
      acceptSettingsFile(path, candidate)
      logForDebugging(`Settings ${internal ? 'internal echo' : 'accepted'} source=${source} path=${path} version=${candidate.identity}`)
      if (!internal) settingsChanged.emit(source)
      return
    }
  })().finally(() => {
    if (pendingReviews.get(path) === review) pendingReviews.delete(path)
  })
  pendingReviews.set(path, review)
  return review
}

function getConfiguredPath(path: string): string {
  const normalizedPath = platformPath.normalize(path)
  return watchedPathAliases.get(normalizedPath) ?? normalizedPath
}

function getSourceForPath(path: string): SettingSource | undefined {
  // Normalize path because chokidar uses forward slashes on Windows
  const normalizedPath = platformPath.normalize(path)

  // Check if the path is inside the managed-settings.d/ drop-in directory
  const dropInDir = getManagedSettingsDropInDir()
  if (normalizedPath.startsWith(dropInDir + platformPath.sep)) {
    return 'policySettings'
  }

  return SETTING_SOURCES.find(
    source => getSettingsFilePathForSource(source) === normalizedPath,
  )
}

/**
 * Start polling for MDM settings changes (registry/plist).
 * Takes a snapshot of current MDM settings and compares on each tick.
 */
function startMdmPoll(): void {
  // Capture initial snapshot (includes both admin MDM and user-writable HKCU)
  const initial = getMdmSettings()
  const initialHkcu = getHkcuSettings()
  lastMdmSnapshot = jsonStringify({
    mdm: initial.settings,
    hkcu: initialHkcu.settings,
  })

  mdmPollTimer = setInterval(() => {
    if (disposed) return

    void (async () => {
      try {
        const { mdm: current, hkcu: currentHkcu } = await refreshMdmSettings()
        if (disposed) return

        const currentSnapshot = jsonStringify({
          mdm: current.settings,
          hkcu: currentHkcu.settings,
        })

        if (currentSnapshot !== lastMdmSnapshot) {
          lastMdmSnapshot = currentSnapshot
          // Update the cache so sync readers pick up new values
          setMdmSettingsCache(current, currentHkcu)
          logForDebugging('Detected MDM settings change via poll')
          fanOut('policySettings')
        }
      } catch (error) {
        logForDebugging(`MDM poll error: ${errorMessage(error)}`)
      }
    })()
  }, testOverrides?.mdmPollInterval ?? MDM_POLL_INTERVAL_MS)

  // Don't let the timer keep the process alive
  mdmPollTimer.unref()
}

/**
 * Non-file producers (remote policy and MDM) invalidate once before notifying.
 * File reviews instead publish the approved parse result with acceptSettingsFile;
 * pending/blocked snapshots survive either kind of derived cache invalidation.
 */
function fanOut(source: SettingSource): void {
  resetSettingsCache()
  settingsChanged.emit(source)
}

/**
 * Manually notify listeners of a settings change.
 * Used for programmatic settings changes (e.g., remote managed settings refresh)
 * that don't involve file system changes.
 */
export function notifyChange(source: SettingSource): void {
  logForDebugging(`Programmatic settings change notification for ${source}`)
  fanOut(source)
}

/**
 * Reset internal state for testing purposes only.
 * This allows re-initialization after dispose().
 * Optionally accepts timing overrides for faster test execution.
 *
 * Closes the watcher and returns the close promise so preload's afterEach
 * can await it BEFORE nuking perTestSettingsDir. Without this, chokidar's
 * pending awaitWriteFinish poll fires on the deleted dir → ENOENT (#25253).
 */
export function resetForTesting(overrides?: {
  stabilityThreshold?: number
  pollInterval?: number
  mdmPollInterval?: number
  deletionGrace?: number
}): Promise<void> {
  lifecycle++
  for (const path of getParsedSettingsPaths()) releaseSettingsFile(path)
  pendingReviews.clear()
  blockedIdentities.clear()
  clearInternalWrites()
  if (mdmPollTimer) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) clearTimeout(timer)
  pendingDeletions.clear()
  lastMdmSnapshot = null
  watchedPathAliases.clear()
  initialized = false
  disposed = false
  testOverrides = overrides ?? null
  const w = watcher
  watcher = null
  return w ? w.close() : Promise.resolve()
}

export const settingsChangeDetector = {
  initialize,
  dispose,
  subscribe,
  notifyChange,
  resetForTesting,
}
