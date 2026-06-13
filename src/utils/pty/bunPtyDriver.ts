import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { resolveInteractiveTerminalCommand } from '../shell/resolveDefaultShell.js'
import type {
  PtyDriver,
  PtyDriverOpenOptions,
  PtyDriverSessionStatus,
  TerminalOutputChunk,
} from './types.js'

interface BunPtySession {
  outputQueue: Array<Omit<TerminalOutputChunk, 'start' | 'end'>>
  proc: Bun.Subprocess
  terminal: Bun.Terminal
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

export function createBunPtyDriver(): PtyDriver & {
  resolveDefaultCommand(): string
} {
  if (typeof Bun === 'undefined' || typeof Bun.spawn !== 'function') {
    throw new Error('InteractiveTerminal requires Bun terminal PTY support')
  }

  const sessions = new Map<string, BunPtySession>()

  return {
    resolveDefaultCommand() {
      return resolveInteractiveTerminalCommand()
    },

    open(options: PtyDriverOpenOptions): PtyDriverSessionStatus {
      const command = options.command ?? resolveInteractiveTerminalCommand()
      const resolvedCommand = resolveCommandPath(command)
      const args = options.args ?? buildShellArgs(command)
      const session = {
        outputQueue: [],
        status: {
          state: 'running',
        },
      } as Pick<BunPtySession, 'outputQueue' | 'status'> &
        Partial<Pick<BunPtySession, 'proc' | 'terminal'>>

      const proc = Bun.spawn([resolvedCommand, ...args], {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env ?? {}),
        },
        terminal: {
          cols: options.cols,
          rows: options.rows,
          data(_terminal, data) {
            session.outputQueue.push({
              text: Buffer.from(data).toString('utf8'),
              stream: 'stdout',
              timestamp: Date.now(),
            })
          },
        },
      })

      if (!proc.terminal) {
        throw new Error('Bun.spawn did not return a terminal')
      }

      session.proc = proc
      session.terminal = proc.terminal
      session.status = {
        state: 'running',
        pid: proc.pid,
      }
      sessions.set(options.sessionId, session as BunPtySession)

      void proc.exited.then(exitCode => {
        if (session.status.state === 'running') {
          session.status = {
            state: 'closed',
            exitCode,
            exitedAt: Date.now(),
            pid: proc.pid,
            signal: null,
          }
        }
      })

      return { ...session.status }
    },

    write(sessionId: string, data: string) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      if (data) {
        session.terminal.write(data)
      }
      return session.outputQueue.shift() ?? null
    },

    resize(sessionId: string, cols: number, rows: number) {
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error(`Unknown PTY session: ${sessionId}`)
      }
      session.terminal.resize(cols, rows)
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
      session.proc.kill(signal)
      session.status = {
        state: 'closed',
        exitCode: signal === 'SIGTERM' ? 143 : 130,
        exitedAt: Date.now(),
        pid: session.proc.pid,
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
        session.terminal.close()
        session.status = {
          state: 'closed',
          exitCode: session.status.exitCode ?? 0,
          exitedAt: Date.now(),
          pid: session.proc.pid,
          signal: session.status.signal ?? null,
        }
      }
      return { ...session.status }
    },
  }
}
