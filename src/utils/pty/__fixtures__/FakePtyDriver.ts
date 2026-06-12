import type {
  PtyDriver,
  PtyDriverOpenOptions,
  PtyDriverSessionStatus,
  TerminalOutputChunk,
} from '../types.js'

interface FakePtyDriverSession {
  status: PtyDriverSessionStatus
}

export class FakePtyDriver implements PtyDriver {
  private readonly sessions = new Map<string, FakePtyDriverSession>()

  open(options: PtyDriverOpenOptions): PtyDriverSessionStatus {
    const status: PtyDriverSessionStatus = {
      state: 'running',
      pid: this.sessions.size + 1000,
    }

    this.sessions.set(options.sessionId, {
      status,
    })

    return status
  }

  write(
    sessionId: string,
    data: string,
  ): Omit<TerminalOutputChunk, 'start' | 'end'> | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.status.state === 'closed') {
      return null
    }

    if (!data) {
      return null
    }

    return {
      text: data,
      stream: 'stdout',
      timestamp: Date.now(),
    }
  }

  resize(sessionId: string, _cols: number, _rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }
  }

  status(sessionId: string): PtyDriverSessionStatus {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }

    return { ...session.status }
  }

  kill(sessionId: string, signal: 'SIGINT' | 'SIGTERM'): PtyDriverSessionStatus {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }

    session.status = {
      state: 'closed',
      exitCode: signal === 'SIGTERM' ? 143 : 130,
      exitedAt: Date.now(),
      pid: session.status.pid,
      signal,
    }

    return { ...session.status }
  }

  close(sessionId: string): PtyDriverSessionStatus {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }

    session.status = {
      state: 'closed',
      exitCode: 0,
      exitedAt: Date.now(),
      pid: session.status.pid,
      signal: null,
    }

    return { ...session.status }
  }
}
