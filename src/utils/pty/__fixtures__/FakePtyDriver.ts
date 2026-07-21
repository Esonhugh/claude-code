import type {
  PtyDriver,
  PtyDriverOpenOptions,
  PtyDriverSessionStatus,
  TerminalOutputChunk,
} from '../types.js'

interface FakePtyDriverSession {
  outputQueue: Array<Omit<TerminalOutputChunk, 'start' | 'end'>>
  status: PtyDriverSessionStatus
  pendingSignal?: 'SIGINT' | 'SIGTERM'
}

export class FakePtyDriver implements PtyDriver {
  readonly killedSignals: Array<{ sessionId: string; signal: 'SIGINT' | 'SIGTERM' }> = []
  readonly writes: Array<{ sessionId: string; data: string }> = []
  private readonly sessions = new Map<string, FakePtyDriverSession>()
  readonly disposedSessions: string[] = []

  open(options: PtyDriverOpenOptions): PtyDriverSessionStatus {
    const status: PtyDriverSessionStatus = {
      state: 'running',
      pid: this.sessions.size + 1000,
    }

    this.sessions.set(options.sessionId, {
      outputQueue: [],
      status,
    })

    return status
  }

  write(
    sessionId: string,
    data: string,
  ): Omit<TerminalOutputChunk, 'start' | 'end'> | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    if (!data) {
      return session.outputQueue.shift() ?? null
    }

    if (session.status.state === 'closed') {
      return null
    }

    this.writes.push({ sessionId, data })

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

    this.killedSignals.push({ sessionId, signal })

    session.status = {
      state: 'closed',
      exitCode: signal === 'SIGTERM' ? 143 : 130,
      exitedAt: Date.now(),
      pid: session.status.pid,
      signal,
    }

    return { ...session.status }
  }

  signalAsynchronously(
    sessionId: string,
    signal: 'SIGINT' | 'SIGTERM',
  ): PtyDriverSessionStatus {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }
    this.killedSignals.push({ sessionId, signal })
    session.pendingSignal = signal
    return { ...session.status }
  }

  finishSignal(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pendingSignal) {
      throw new Error(`No pending signal for PTY session: ${sessionId}`)
    }
    const signal = session.pendingSignal
    session.pendingSignal = undefined
    session.status = {
      state: 'closed',
      exitCode: signal === 'SIGTERM' ? 143 : 130,
      exitedAt: Date.now(),
      pid: session.status.pid,
      signal,
    }
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

  enqueueOutput(sessionId: string, output: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }
    session.outputQueue.push({
      text: output,
      stream: 'stdout',
      timestamp: Date.now(),
    })
  }

  finishNaturally(
    sessionId: string,
    output: string,
    exitCode = 0,
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }

    this.enqueueOutput(sessionId, output)
    session.status = {
      state: 'closed',
      exitCode,
      exitedAt: Date.now(),
      pid: session.status.pid,
      signal: null,
    }
  }

  dispose(sessionId: string): void {
    this.disposedSessions.push(sessionId)
    this.sessions.delete(sessionId)
  }
}
