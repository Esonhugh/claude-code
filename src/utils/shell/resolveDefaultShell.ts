import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type ShellSettings = {
  defaultShell?: 'bash' | 'powershell'
}

let shellSettingsOverride: ShellSettings | null | undefined

export function setShellSettingsOverrideForTesting(
  settings: ShellSettings | null | undefined,
): void {
  shellSettingsOverride = settings
}

function tryGetInitialSettings(): ShellSettings | null {
  if (shellSettingsOverride !== undefined) {
    return shellSettingsOverride
  }
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

function mergedEnv(inputEnv?: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(inputEnv ?? {}),
  }
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

function getPathExts(env: Record<string, string | undefined>): string[] {
  if (process.platform !== 'win32') {
    return ['']
  }
  return (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
}

function getExecutableCandidates(command: string, env: Record<string, string | undefined>): string[] {
  const exts = getPathExts(env)
  if (exts.length === 1 && exts[0] === '') {
    return [command]
  }
  const lower = command.toLowerCase()
  if (exts.some(ext => lower.endsWith(ext.toLowerCase()))) {
    return [command]
  }
  return [command, ...exts.map(ext => `${command}${ext.toLowerCase()}`)]
}

function assertExecutable(path: string): string {
  accessSync(path, fsConstants.X_OK)
  return path
}

function tryResolveExecutable(
  command: string,
  options: { cwd: string; env: Record<string, string | undefined> },
): string | null {
  const candidates = getExecutableCandidates(command, options.env)

  for (const candidate of candidates) {
    try {
      if (isAbsolute(candidate)) {
        return assertExecutable(candidate)
      }

      if (hasPathSeparator(candidate)) {
        return assertExecutable(resolve(options.cwd, candidate))
      }

      const pathEntries = (options.env.PATH ?? '').split(delimiter).filter(Boolean)
      for (const entry of pathEntries) {
        try {
          return assertExecutable(join(entry, candidate))
        } catch {
          // Try next PATH entry.
        }
      }
    } catch {
      // Try next candidate.
    }
  }

  return null
}

function defaultShellArgs(command: string): string[] {
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (
    basename === 'pwsh' ||
    basename === 'pwsh.exe' ||
    basename === 'powershell' ||
    basename === 'powershell.exe'
  ) {
    return ['-NoLogo']
  }
  return []
}

export function resolveTerminalCommand(input: {
  command?: string
  cwd?: string
  env?: Record<string, string>
} = {}): { command: string; args: string[] } {
  const cwd = input.cwd || process.cwd()
  const env = mergedEnv(input.env)
  const requestedCommand = input.command

  if (requestedCommand !== undefined && requestedCommand.trim() !== '') {
    const resolved = tryResolveExecutable(requestedCommand, { cwd, env })
    if (!resolved) {
      throw new Error(`Unable to resolve terminal command: ${requestedCommand}`)
    }
    return { command: resolved, args: defaultShellArgs(resolved) }
  }

  const envShell = env.SHELL?.trim()
  if (envShell) {
    const resolved = tryResolveExecutable(envShell, { cwd, env })
    if (resolved) {
      return { command: resolved, args: defaultShellArgs(resolved) }
    }
  }

  const fallbackShells =
    resolveDefaultShell() === 'powershell' ? ['pwsh', 'powershell'] : ['bash']
  for (const fallbackShell of fallbackShells) {
    const resolvedFallback = tryResolveExecutable(fallbackShell, { cwd, env })
    if (resolvedFallback) {
      return { command: resolvedFallback, args: defaultShellArgs(resolvedFallback) }
    }
  }

  const fallbackShell = fallbackShells[0]!
  return { command: fallbackShell, args: defaultShellArgs(fallbackShell) }
}
