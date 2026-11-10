import type {
  PtyDriver,
  PtyDriverOpenOptions,
  PtyDriverSessionStatus,
  TerminalOutputChunk,
} from './types.js'
import { DEFAULT_MAX_BUFFERED_CHUNKS } from './types.js'

const MAX_QUEUED_CHARS = 8 * 1024 * 1024

interface BunPtySession {
  outputQueue: Array<Omit<TerminalOutputChunk, 'start' | 'end'>>
  queuedChars: number
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
        queuedChars: 0,
        status: {
          state: 'running',
        },
      } as Pick<BunPtySession, 'outputQueue' | 'queuedChars' | 'status'> &
        Partial<Pick<BunPtySession, 'proc' | 'terminal' | 'pendingSignal'>>

      // A Terminal session is not a pane of the user's tmux: without this,
      // tmux run inside it would attach to the outer session's server.
      const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...inheritedEnv } = process.env
      const proc = Bun.spawn([options.command, ...options.args], {
        cwd: options.cwd,
        env: {
          ...inheritedEnv,
          ...(options.env ?? {}),
        },
        terminal: {
          cols: options.cols,
          rows: options.rows,
          data(_terminal, data) {
            const text = Buffer.from(data).toString('utf8')
            const queue = session.outputQueue
            session.queuedChars += text.length
            // The screen is rebuilt from every byte, so a full queue merges
            // into its last chunk; dropping chunks would lose the redraws a
            // full-screen app does not repeat. Only a backlog past
            // MAX_QUEUED_CHARS sheds the oldest output.
            if (queue.length < DEFAULT_MAX_BUFFERED_CHUNKS) {
              queue.push({ text, stream: 'stdout', timestamp: Date.now() })
            } else {
              const last = queue[queue.length - 1]!
              last.text += text
              last.timestamp = Date.now()
            }
            while (queue.length > 1 && session.queuedChars > MAX_QUEUED_CHARS) {
              session.queuedChars -= queue.shift()!.text.length
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
      const chunk = session.outputQueue.shift()
      if (!chunk) return null
      session.queuedChars -= chunk.text.length
      return chunk
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
