import { readFile, readlink } from 'fs/promises'
import { createRequire } from 'module'
import { hostname } from 'os'
import { logForDebugging } from './debug.js'
import {
  execFileNoThrowWithCwd,
  execSyncWithDefaults_DEPRECATED,
} from './execFileNoThrow.js'

// This file contains platform-agnostic implementations of common `ps` type commands.
// When adding new code to this file, make sure to handle:
// - Win32, as `ps` within cygwin and WSL may not behave as expected, particularly when attempting to access processes on the host.
// - Unix vs BSD-style `ps` have different options.

const windowsProcessFunctions = {
  OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
  GetProcessTimes: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  CloseHandle: { args: ['ptr'], returns: 'i32' },
} as const
let windowsProcessLibrary: import('bun:ffi').Library<typeof windowsProcessFunctions> | null | undefined

function getWindowsProcessLibrary() {
  if (windowsProcessLibrary !== undefined) return windowsProcessLibrary
  try {
    // Resolve at runtime: Node uses PowerShell, while compiled Bun keeps its native FFI.
    const load = createRequire(import.meta.url)
    const ffi = load('bun:ffi') as typeof import('bun:ffi')
    windowsProcessLibrary = ffi.dlopen('kernel32.dll', windowsProcessFunctions)
    logForDebugging('[win32-proc-times] bun:ffi loaded, using procStartFt')
  } catch {
    windowsProcessLibrary = null
    logForDebugging('[win32-proc-times] bun:ffi unavailable, falling back to PowerShell')
  }
  return windowsProcessLibrary
}

export async function getProcessStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  if (process.platform === 'win32') {
    if (pid > 0xffffffff) return
    const library = getWindowsProcessLibrary()
    if (library) {
      const handle = library.symbols.OpenProcess(4096, 0, pid)
      if (!handle) return
      try {
        const creation = new Uint8Array(8)
        if (!library.symbols.GetProcessTimes(handle, creation, new Uint8Array(8), new Uint8Array(8), new Uint8Array(8))) return
        return new DataView(creation.buffer).getBigUint64(0, true).toString()
      } catch {
        return
      } finally {
        library.symbols.CloseHandle(handle)
      }
    }
    const result = await execFileNoThrowWithCwd('powershell.exe', [
      '-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.Ticks`,
    ], { timeout: 1000 })
    const start = result.stdout.trim()
    return result.code === 0 && /^\d+$/.test(start) ? start : undefined
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // comm may contain spaces and closing parentheses; starttime is field 22.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      return start && /^\d+$/.test(start) ? start : undefined
    } catch {
      return
    }
  }
  const result = await execFileNoThrowWithCwd('ps', ['-o', 'lstart=', '-p', String(pid)], {
    timeout: 1000,
    env: { LC_ALL: 'C', TZ: 'UTC' },
  })
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined
}

export async function getProcessStartMetadata(pid: number): Promise<{ procStart?: string; procStartFt?: string }> {
  const start = await getProcessStart(pid)
  return process.platform === 'win32' && getWindowsProcessLibrary()
    ? { procStartFt: start }
    : { procStart: start }
}

export async function isProcessStartMatching(pid: number, metadata: { procStart?: unknown; procStartFt?: unknown }): Promise<boolean> {
  // FILETIME and PowerShell DateTime ticks have different epochs and cannot be compared directly.
  const expected = process.platform === 'win32' && getWindowsProcessLibrary()
    ? metadata.procStart === undefined ? metadata.procStartFt : undefined
    : metadata.procStart
  if (typeof expected !== 'string') return true
  const actual = await getProcessStart(pid)
  return actual === undefined || actual === expected
}

export async function getProcessPidDomain(): Promise<string> {
  if (process.platform === 'win32') return `win32:${hostname().toLowerCase()}`
  if (process.platform !== 'linux') return process.platform
  const [machineId, pidNamespace] = await Promise.all([
    readFile('/etc/machine-id', 'utf8').then(value => value.trim(), () => ''),
    readlink('/proc/self/ns/pid').catch(() => ''),
  ])
  return `linux:${machineId}:${pidNamespace}`
}

/**
 * Check process liveness using signal 0. EPERM is treated as unavailable:
 * peer discovery only needs processes accessible to the current user.
 */
export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Gets the ancestor process chain for a given process (up to maxDepth levels)
 * @param pid - The starting process ID
 * @param maxDepth - Maximum number of ancestors to fetch (default: 10)
 * @returns Array of ancestor PIDs from immediate parent to furthest ancestor
 */
export async function getAncestorPidsAsync(
  pid: string | number,
  maxDepth = 10,
): Promise<number[]> {
  if (process.platform === 'win32') {
    // For Windows, use a PowerShell script that walks the process tree
    const script = `
      $pid = ${String(pid)}
      $ancestors = @()
      for ($i = 0; $i -lt ${maxDepth}; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
        if (-not $proc -or -not $proc.ParentProcessId -or $proc.ParentProcessId -eq 0) { break }
        $pid = $proc.ParentProcessId
        $ancestors += $pid
      }
      $ancestors -join ','
    `.trim()

    const result = await execFileNoThrowWithCwd(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 3000 },
    )
    if (result.code !== 0 || !result.stdout?.trim()) {
      return []
    }
    return result.stdout
      .trim()
      .split(',')
      .filter(Boolean)
      .map(p => parseInt(p, 10))
      .filter(p => !isNaN(p))
  }

  // For Unix, use a shell command that walks up the process tree
  // This uses a single process invocation instead of multiple sequential calls
  const script = `pid=${String(pid)}; for i in $(seq 1 ${maxDepth}); do ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' '); if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ]; then break; fi; echo $ppid; pid=$ppid; done`

  const result = await execFileNoThrowWithCwd('sh', ['-c', script], {
    timeout: 3000,
  })
  if (result.code !== 0 || !result.stdout?.trim()) {
    return []
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(p => parseInt(p, 10))
    .filter(p => !isNaN(p))
}

/**
 * Gets the command line for a given process
 * @param pid - The process ID to get the command for
 * @returns The command line string, or null if not found
 * @deprecated Use getAncestorCommandsAsync instead
 */
export function getProcessCommand(pid: string | number): string | null {
  try {
    const pidStr = String(pid)
    const command =
      process.platform === 'win32'
        ? `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pidStr}\\").CommandLine"`
        : `ps -o command= -p ${pidStr}`

    const result = execSyncWithDefaults_DEPRECATED(command, { timeout: 1000 })
    return result ? result.trim() : null
  } catch {
    return null
  }
}

/**
 * Gets the command lines for a process and its ancestors in a single call
 * @param pid - The starting process ID
 * @param maxDepth - Maximum depth to traverse (default: 10)
 * @returns Array of command strings for the process chain
 */
export async function getAncestorCommandsAsync(
  pid: string | number,
  maxDepth = 10,
): Promise<string[]> {
  if (process.platform === 'win32') {
    // For Windows, use a PowerShell script that walks the process tree and collects commands
    const script = `
      $currentPid = ${String(pid)}
      $commands = @()
      for ($i = 0; $i -lt ${maxDepth}; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        if ($proc.CommandLine) { $commands += $proc.CommandLine }
        if (-not $proc.ParentProcessId -or $proc.ParentProcessId -eq 0) { break }
        $currentPid = $proc.ParentProcessId
      }
      $commands -join [char]0
    `.trim()

    const result = await execFileNoThrowWithCwd(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 3000 },
    )
    if (result.code !== 0 || !result.stdout?.trim()) {
      return []
    }
    return result.stdout.split('\0').filter(Boolean)
  }

  // For Unix, use a shell command that walks up the process tree and collects commands
  // Using null byte as separator to handle commands with newlines
  const script = `currentpid=${String(pid)}; for i in $(seq 1 ${maxDepth}); do cmd=$(ps -o command= -p $currentpid 2>/dev/null); if [ -n "$cmd" ]; then printf '%s\\0' "$cmd"; fi; ppid=$(ps -o ppid= -p $currentpid 2>/dev/null | tr -d ' '); if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ]; then break; fi; currentpid=$ppid; done`

  const result = await execFileNoThrowWithCwd('sh', ['-c', script], {
    timeout: 3000,
  })
  if (result.code !== 0 || !result.stdout?.trim()) {
    return []
  }
  return result.stdout.split('\0').filter(Boolean)
}

/**
 * Gets the child process IDs for a given process
 * @param pid - The parent process ID
 * @returns Array of child process IDs as numbers
 */
export function getChildPids(pid: string | number): number[] {
  try {
    const pidStr = String(pid)
    const command =
      process.platform === 'win32'
        ? `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${pidStr}\\").ProcessId"`
        : `pgrep -P ${pidStr}`

    const result = execSyncWithDefaults_DEPRECATED(command, { timeout: 1000 })
    if (!result) {
      return []
    }
    return result
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(p => parseInt(p, 10))
      .filter(p => !isNaN(p))
  } catch {
    return []
  }
}
