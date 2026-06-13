import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type ShellSettings = {
  defaultShell?: 'bash' | 'powershell'
}

function tryGetInitialSettings(): ShellSettings | null {
  try {
    return require('../settings/settings.js').getInitialSettings()
  } catch {
    try {
      return require('../settings/settings.ts').getInitialSettings()
    } catch {
      return null
    }
  }
}

/**
 * Resolve the default shell for input-box `!` commands.
 *
 * Resolution order (docs/design/ps-shell-selection.md §4.2):
 *   settings.defaultShell → 'bash'
 *
 * Platform default is 'bash' everywhere — we do NOT auto-flip Windows to
 * PowerShell (would break existing Windows users with bash hooks).
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  return tryGetInitialSettings()?.defaultShell ?? 'bash'
}

function isExecutableCommand(command: string): boolean {
  if (!command) {
    return false
  }

  try {
    if (isAbsolute(command)) {
      accessSync(command, fsConstants.X_OK)
      return true
    }

    const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    for (const entry of pathEntries) {
      try {
        accessSync(join(entry, command), fsConstants.X_OK)
        return true
      } catch {
        // Try next PATH entry.
      }
    }
  } catch {
    return false
  }

  return false
}

export function resolveInteractiveTerminalCommand(): string {
  const envShell = process.env.SHELL?.trim()
  if (envShell && isExecutableCommand(envShell)) {
    return envShell
  }

  const fallbackShell =
    resolveDefaultShell() === 'powershell' ? 'powershell' : 'bash'
  if (isExecutableCommand(fallbackShell)) {
    return fallbackShell
  }

  return 'bash'
}
