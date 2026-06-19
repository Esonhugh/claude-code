import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { clearCommandsCache } from '../commands.js'
import { getCwd } from './cwd.js'
import { isENOENT } from './errors.js'
import { onCwdChangedForHooks } from './hooks/fileChangedWatcher.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { setCwd } from './Shell.js'

type ChangeSessionCwdOptions = {
  relativeTo?: string
  clearCommandCaches?: () => void
  shouldClearCommandCaches?: boolean
  invalidateEnv?: () => void
  notifyHooks?: (oldCwd: string, newCwd: string) => void | Promise<void>
}

export function changeSessionCwd(
  path: string,
  options: ChangeSessionCwdOptions = {},
): string {
  const oldCwd = getCwd()
  const resolved = isAbsolute(path)
    ? path
    : resolve(options.relativeTo ?? oldCwd, path)
  let stat
  try {
    stat = statSync(resolved)
  } catch (error) {
    if (isENOENT(error)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }
    throw error
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path "${resolved}" is not a directory`)
  }

  setCwd(resolved, options.relativeTo ?? oldCwd)
  const newCwd = getCwd()
  if (newCwd === oldCwd) return newCwd

  ;(options.invalidateEnv ?? invalidateSessionEnvCache)()
  if (options.shouldClearCommandCaches ?? true) {
    ;(options.clearCommandCaches ?? clearCommandsCache)()
  }
  SandboxManager.cleanupAfterCommand()
  void (options.notifyHooks ?? onCwdChangedForHooks)(oldCwd, newCwd)

  return newCwd
}
