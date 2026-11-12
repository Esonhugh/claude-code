/**
 * Lazy accessor for proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). Static imports of proper-lockfile pull this
 * cost into the startup path even when no locking happens (e.g. `--help`).
 *
 * Import this module instead of `proper-lockfile` directly. The underlying
 * package is only loaded the first time a lock function is actually called.
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

type Lockfile = typeof import('proper-lockfile')

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}

const lockWait = new Int32Array(new SharedArrayBuffer(4))

/**
 * Runs `run` while holding a cross-process lock on `file` (which need not
 * exist; its directory must). Waits up to `waitMs` for another process to
 * release it. If the lock cannot be taken (busy past the wait, or the lock
 * directory cannot be created) `run` still runs unlocked, as the writers did
 * before; `onUnlocked` says why.
 */
export function withLockSync<T>(
  file: string,
  run: () => T,
  onUnlocked: (reason: unknown) => void,
  waitMs = 3000,
): T {
  const deadline = Date.now() + waitMs
  let release: (() => void) | undefined
  for (;;) {
    try {
      release = lockSync(file, {
        realpath: false,
        lockfilePath: `${file}.lock`,
        // A lock left by a crashed process is taken over after 2s.
        stale: 2000,
        onCompromised: onUnlocked,
      })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) {
        onUnlocked(error)
        break
      }
      Atomics.wait(lockWait, 0, 0, 5)
    }
  }
  try {
    return run()
  } finally {
    try {
      release?.()
    } catch (error) {
      onUnlocked(error)
    }
  }
}
