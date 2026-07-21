import type {
  PtyDriver,
  PtyDriverOpenOptions,
  PtyDriverSessionStatus,
  TerminalOutputChunk,
} from './types.js'
import { DEFAULT_MAX_BUFFERED_CHUNKS } from './types.js'

interface BunPtySession {
  outputQueue: Array<Omit<TerminalOutputChunk, 'start' | 'end'>>
  proc: Bun.Subprocess
  terminal: Bun.Terminal
  status: PtyDriverSessionStatus
  pendingSignal?: 'SIGINT' | 'SIGTERM'
}

export function createBunPtyDriver(): PtyDriver & {
  resolveDefaultCommand(): string
} {
  if (typeof Bun === 'undefined' || typeof Bun.spawn !== 'function') {
    throw new Error('Terminal requires Bun terminal PTY support')
  }

  const sessions = new Map<string, BunPtySession>()

  return {
    resolveDefaultCommand() {
      throw new Error('Default command resolution is handled by PtySessionManager')
    },

    open(options: PtyDriverOpenOptions): PtyDriverSessionStatus {
      const session = {
        outputQueue: [],
        status: {
          state: 'running',
        },
      } as Pick<BunPtySession, 'outputQueue' | 'status'> &
        Partial<Pick<BunPtySession, 'proc' | 'terminal' | 'pendingSignal'>>

      const proc = Bun.spawn([options.command, ...options.args], {
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
            while (session.outputQueue.length > DEFAULT_MAX_BUFFERED_CHUNKS) {
              session.outputQueue.shift()
            }
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
          const signalCode = proc.signalCode as NodeJS.Signals | null
          const signal =
            signalCode ??
            (session.pendingSignal === 'SIGTERM' && exitCode === 143
              ? 'SIGTERM'
              : session.pendingSignal === 'SIGINT' && exitCode === 130
                ? 'SIGINT'
                : null)
          session.status = {
            state: 'closed',
            exitCode,
            exitedAt: Date.now(),
            pid: proc.pid,
            signal,
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
      session.pendingSignal = signal
      session.proc.kill(signal)
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

    dispose(sessionId: string) {
      sessions.delete(sessionId)
    },
  }
}
