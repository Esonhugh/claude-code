import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { lock } from '../lockfile.js'
import { convertDirectoryToZipInPlace } from './zipCache.js'
import { getErrnoCode } from '../errors.js'
import { logForDebugging } from '../debug.js'

const PUBLICATION_NAME =
  /\.(tmp|rollback)\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STALE_MS = 60 * 60 * 1000
export function isPluginPublicationEntry(name: string): boolean {
  return PUBLICATION_NAME.test(name) || name.endsWith('.publish.lock')
}
async function publicationLock(finalPath: string, retries: boolean) {
  return lock(finalPath, {
    realpath: false,
    lockfilePath: `${finalPath}.publish.lock`,
    // The retry window must outlast a dead owner's ten-second stale lease.
    // Keep the normal heartbeat lease so a busy live publisher stays protected.
    stale: 10000,
    retries: retries ? { retries: 20, minTimeout: 25, maxTimeout: 1000 } : 0,
  })
}

/** Build a sibling directory before replacing the published tree. */
export async function publishDirectory(
  finalPath: string,
  build: (stagingPath: string) => Promise<void>,
  zipPath?: string,
): Promise<void> {
  await mkdir(dirname(finalPath), { recursive: true })
  const release = await publicationLock(finalPath, true)
  const staging = `${finalPath}.tmp.${process.pid}.${randomUUID()}`
  let backup: string | undefined
  const errors: unknown[] = []
  try {
    await build(staging)
    // Refuse to publish a builder that did not leave a complete directory.
    if (!(await lstat(staging)).isDirectory())
      throw new Error(`Plugin staging path is not a directory: ${staging}`)
    if (zipPath) {
      await convertDirectoryToZipInPlace(staging, zipPath)
    } else {
      backup = `${finalPath}.rollback.${process.pid}.${randomUUID()}`
      try {
        await rename(finalPath, backup)
      } catch (error) {
        if (getErrnoCode(error) !== 'ENOENT') throw error
        backup = undefined
      }
      try {
        await rename(staging, finalPath)
      } catch (error) {
        errors.push(error)
        if (backup) {
          try {
            await rename(backup, finalPath)
            backup = undefined
          } catch (restoreError) {
            errors.push(restoreError)
          }
        }
      }
    }
    if (errors.length === 0) {
      logForDebugging(`[Plugins:cache] published ${zipPath ?? finalPath}`)
      if (backup) {
        await rm(backup, { recursive: true, force: true })
        backup = undefined
      }
    }
  } catch (error) {
    errors.push(error)
  }
  try {
    await rm(staging, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  try {
    await release()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      `Plugin directory publication failed: ${finalPath}`,
    )
}

function processMayBeRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return getErrnoCode(error) !== 'ESRCH'
  }
}

/** Only names made by this publisher, owned by dead processes, are reclaimable. */
export async function cleanupPluginPublicationEntry(
  path: string,
  now: number,
  installed: ReadonlySet<string> = new Set(),
): Promise<void> {
  const match = PUBLICATION_NAME.exec(path)
  if (!match || installed.has(resolve(path))) return
  const entry = await lstat(path)
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    processMayBeRunning(Number(match[2]))
  )
    return
  const finalPath = path.slice(0, match.index)
  let release: () => Promise<void>
  try {
    release = await publicationLock(finalPath, false)
  } catch (error) {
    if (getErrnoCode(error) === 'ELOCKED') return
    throw error
  }
  try {
    if (match[1] === 'rollback') {
      try {
        await lstat(finalPath)
      } catch (error) {
        if (getErrnoCode(error) !== 'ENOENT') throw error
        await rename(path, finalPath)
        logForDebugging(
          `[Plugins:cache] recovered ${finalPath} from interrupted publication`,
        )
        return
      }
    }
    if (now - entry.mtimeMs > STALE_MS) {
      await rm(path, { recursive: true, force: true })
      logForDebugging(
        `[Plugins:cache] removed stale publication directory ${path}`,
      )
    }
  } finally {
    await release()
  }
}

/** Empty registries still need to reclaim an interrupted first install. */
export async function cleanupUninstalledPluginStaging(
  cachePath: string,
  now: number,
  installed: ReadonlySet<string> = new Set(),
): Promise<void> {
  const subdirs = async (path: string) => {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => join(path, entry.name))
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return []
      throw error
    }
  }
  for (const market of await subdirs(cachePath))
    for (const plugin of await subdirs(market)) {
      for (const version of await subdirs(plugin)) {
        if (isPluginPublicationEntry(version))
          await cleanupPluginPublicationEntry(version, now, installed)
      }
    }
}
