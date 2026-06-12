import { accessSync, chmodSync, constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import pty from 'node-pty'
import { resolveInteractiveTerminalCommand } from '../shell/resolveDefaultShell.js'
import type {
  PtyDriver,
  PtyDriverOpenOptions,
  PtyDriverSessionStatus,
  TerminalOutputChunk,
} from './types.js'

interface NodePtySession {
  outputQueue: Array<Omit<TerminalOutputChunk, 'start' | 'end'>>
  proc?: pty.IPty
  status: PtyDriverSessionStatus
}

function buildShellArgs(command: string): string[] {
  if (command === 'powershell' || command.endsWith('/pwsh')) {
    return ['-NoLogo']
  }
  return []
}

function getExecutableCandidates(command: string): string[] {
  const baseCandidates =
    command === 'powershell' ? ['pwsh', 'powershell'] : [command]

  if (process.platform !== 'win32') {
    return baseCandidates
  }

  const pathExts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)

  return baseCandidates.flatMap(candidate => {
    const lower = candidate.toLowerCase()
    if (pathExts.some(ext => lower.endsWith(ext.toLowerCase()))) {
      return [candidate]
    }
    return [candidate, ...pathExts.map(ext => `${candidate}${ext.toLowerCase()}`)]
  })
}

function resolveCommandPath(command: string): string {
  const candidates = getExecutableCandidates(command)

  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    }

    const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    for (const entry of pathEntries) {
      const fullPath = join(entry, candidate)
      try {
        accessSync(fullPath, fsConstants.X_OK)
        return fullPath
      } catch {
        // Try next candidate/path.
      }
    }
  }

  throw new Error(`Unable to resolve terminal command: ${command}`)
}

function ensureSpawnHelperExecutable(): void {
  const require = createRequire(import.meta.url)
  const packageJsonPath = require.resolve('node-pty/package.json')
  const packageDir = dirname(packageJsonPath)
  const helperPath = join(
    packageDir,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  )

  try {
    accessSync(helperPath, fsConstants.X_OK)
  } catch {
    chmodSync(helperPath, 0o755)
  }
}

export function createNodePtyDriver(): PtyDriver & {
  resolveDefaultCommand(): string
} {
  ensureSpawnHelperExecutable()
  const sessions = new Map<string, NodePtySession>()

  return {
    resolveDefaultCommand() {
      return resolveInteractiveTerminalCommand()
    },

    open(options: PtyDriverOpenOptions): PtyDriverSessionStatus {
      const command = options.command ?? resolveInteractiveTerminalCommand()
      const resolvedCommand = resolveCommandPath(command)
      const args = options.args ?? buildShellArgs(command)
      const proc = pty.spawn(resolvedCommand, args, {
        name: 'xterm-color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env ?? {}),
        },
      })

      const session: NodePtySession = {
        outputQueue: [],
        proc,
        status: {
          state: 'running',
          pid: proc.pid,
        },
      }

      proc.onData(text => {
        session.outputQueue.push({
          text,
          stream: 'stdout',
          timestamp: Date.now(),
        })
      })

      proc.onExit(event => {
        session.status = {
          state: 'closed',
          exitCode: event.exitCode,
          exitedAt: Date.now(),
          signal: event.signal ? String(event.signal) as NodeJS.Signals : null,
        }
      })

      sessions.set(options.sessionId, session)
      return { ...session.status }
    },

    write(sessionId: string, data: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      if (data) {
        session.proc?.write(data)
      }
      return session.outputQueue.shift() ?? null
    },

    resize(sessionId: string, cols: number, rows: number) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      session.proc?.resize(cols, rows)
    },

    status(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      return { ...session.status }
    },

    kill(sessionId: string, signal: 'SIGINT' | 'SIGTERM') {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      const pid = session.proc?.pid ?? session.status.pid
      session.proc?.kill(signal)
      session.proc = undefined
      session.status = {
        state: 'closed',
        exitCode: signal === 'SIGTERM' ? 143 : 130,
        exitedAt: Date.now(),
        pid,
        signal,
      }
      return { ...session.status }
    },

    close(sessionId: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      if (session.status.state === 'running') {
        const pid = session.proc?.pid ?? session.status.pid
        session.proc?.kill()
        session.proc = undefined
        session.status = {
          state: 'closed',
          exitCode: session.status.exitCode ?? 0,
          exitedAt: Date.now(),
          pid,
          signal: session.status.signal ?? null,
        }
      }
      return { ...session.status }
    },
  }
}
