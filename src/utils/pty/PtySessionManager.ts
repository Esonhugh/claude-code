import { resolveTerminalCommand } from '../shell/resolveDefaultShell.js'
import {
  DEFAULT_MAX_BUFFERED_CHUNKS,
  INITIAL_TERMINAL_SIZE,
  MAX_TERMINAL_SIZE,
  type OpenTerminalSessionOptions,
  type PtyDriver,
  type TerminalOutputChunk,
  type TerminalReadResult,
  type TerminalSessionRecord,
} from './types.js'
import {
  applyTerminalOutput,
  createTerminalScreenRenderer,
  renderedPreview,
  resizeTerminalScreenRenderer,
  type TerminalScreenRenderer,
} from './terminalScreenRenderer.js'

interface PtySessionManagerOptions {
  driver: PtyDriver
  exitedSessionTtlMs?: number
  maxBufferedChunks?: number
}

interface ManagedSession {
  outputChunks: TerminalOutputChunk[]
  record: TerminalSessionRecord
  renderer: TerminalScreenRenderer
}

export class PtySessionManager {
  private readonly driver: PtyDriver
  private readonly exitedSessionTtlMs: number
  private readonly maxBufferedChunks: number
  private readonly sessions = new Map<string, ManagedSession>()
  private nextSessionId = 1

  constructor(options: PtySessionManagerOptions) {
    this.driver = options.driver
    this.exitedSessionTtlMs = options.exitedSessionTtlMs ?? 60_000
    this.maxBufferedChunks = options.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED_CHUNKS
  }

  open(options: OpenTerminalSessionOptions): TerminalSessionRecord {
    const sessionId = `term-${this.nextSessionId++}`
    const startedAt = Date.now()
    const cols = this.validateSize('cols', options.cols ?? INITIAL_TERMINAL_SIZE.cols)
    const rows = this.validateSize('rows', options.rows ?? INITIAL_TERMINAL_SIZE.rows)
    const resolved = resolveTerminalCommand({
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    })
    const args = options.args ?? resolved.args
    const status = this.driver.open({
      args,
      command: resolved.command,
      cols,
      cwd: options.cwd,
      env: options.env,
      rows,
      sessionId,
    })

    const record: TerminalSessionRecord = {
      args,
      cols,
      command: resolved.command,
      cwd: options.cwd,
      lastActivityAt: startedAt,
      lowestAvailableCursor: 0,
      nextCursor: 0,
      rows,
      sessionId,
      startedAt,
      state: status.state,
      truncatedBeforeCursor: false,
    }

    this.applyDriverStatus(record, status)
    this.sessions.set(sessionId, {
      outputChunks: [],
      record,
      renderer: createTerminalScreenRenderer(cols, rows),
    })

    return this.cloneRecord(record)
  }

  write(sessionId: string, data: string): void {
    this.reapExpiredSessions()
    const session = this.getWritableSession(sessionId)
    session.record.lastActivityAt = Date.now()
    const output = this.driver.write(sessionId, data)
    this.appendOutput(session, output)
  }

  read(_sessionId: string, _cursor: number): TerminalReadResult {
    this.reapExpiredSessions()
    const session = this.getSession(_sessionId)
    if (session.record.state === 'running') {
      this.refreshRunningSession(_sessionId, session)
    }
    const text = renderedPreview(session.renderer)
    const end = Buffer.byteLength(text, 'utf8')

    return {
      chunks: text
        ? [
            {
              end,
              start: 0,
              stream: 'stdout',
              text,
              timestamp: session.record.lastActivityAt,
            },
          ]
        : [],
      lowestAvailableCursor: 0,
      nextCursor: end,
      truncatedBeforeCursor: false,
    }
  }

  status(sessionId: string): TerminalSessionRecord {
    this.reapExpiredSessions()
    const session = this.getSession(sessionId)
    if (session.record.state === 'running') {
      this.refreshRunningSession(sessionId, session)
    }
    return this.cloneRecord(session.record)
  }

  list(): TerminalSessionRecord[] {
    this.reapExpiredSessions()
    return Array.from(this.sessions, ([sessionId, session]) => {
      if (session.record.state === 'running') {
        this.refreshRunningSession(sessionId, session)
      }
      return this.cloneRecord(session.record)
    })
  }

  getRenderedPreview(sessionId: string): string {
    this.reapExpiredSessions()
    const session = this.getSession(sessionId)
    if (session.record.state === 'running') {
      this.refreshRunningSession(sessionId, session)
    }
    return renderedPreview(session.renderer)
  }

  resize(sessionId: string, cols: number, rows: number): TerminalSessionRecord {
    this.reapExpiredSessions()
    const session = this.getWritableSession(sessionId)
    cols = this.validateSize('cols', cols)
    rows = this.validateSize('rows', rows)
    this.driver.resize?.(sessionId, cols, rows)
    session.record.cols = cols
    session.record.rows = rows
    resizeTerminalScreenRenderer(session.renderer, cols, rows)
    session.record.lastActivityAt = Date.now()
    return this.cloneRecord(session.record)
  }

  signal(sessionId: string, signal: 'SIGINT' | 'SIGTERM'): TerminalSessionRecord {
    this.reapExpiredSessions()
    const session = this.getWritableSession(sessionId)
    session.record.lastActivityAt = Date.now()
    const status = this.driver.kill?.(sessionId, signal) ?? this.driver.close(sessionId)
    this.applyDriverStatus(session.record, status)
    return this.cloneRecord(session.record)
  }

  close(sessionId: string, _force = false): TerminalSessionRecord {
    this.reapExpiredSessions()
    const session = this.getSession(sessionId)
    this.applyDriverStatus(session.record, this.driver.close(sessionId))
    session.record.lastActivityAt = Date.now()
    return this.cloneRecord(session.record)
  }

  reapExpiredSessions(now = Date.now()): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.record.state !== 'closed' && session.record.state !== 'exited') {
        continue
      }
      if (now - session.record.lastActivityAt >= this.exitedSessionTtlMs) {
        this.driver.dispose?.(sessionId)
        this.sessions.delete(sessionId)
      }
    }
  }

  private appendOutput(
    session: ManagedSession,
    output: Omit<TerminalOutputChunk, 'start' | 'end'> | null,
  ): void {
    if (!output) {
      return
    }

    const start = session.record.nextCursor
    const end = start + Buffer.byteLength(output.text, 'utf8')
    session.outputChunks.push({
      ...output,
      start,
      end,
    })
    applyTerminalOutput(session.renderer, output.text)
    session.record.nextCursor = end
    session.record.lastActivityAt = Date.now()
    this.trimBuffer(session)
  }

  private refreshRunningSession(sessionId: string, session: ManagedSession): void {
    this.drainDriverOutput(sessionId, session)
    this.applyDriverStatus(session.record, this.driver.status(sessionId))
    this.drainDriverOutput(sessionId, session)
  }

  private drainDriverOutput(sessionId: string, session: ManagedSession): void {
    while (true) {
      const output = this.driver.write(sessionId, '')
      if (!output) {
        break
      }
      this.appendOutput(session, output)
    }
  }

  private trimBuffer(session: ManagedSession): void {
    while (session.outputChunks.length > this.maxBufferedChunks) {
      const removedChunk = session.outputChunks.shift()
      if (!removedChunk) {
        break
      }

      session.record.lowestAvailableCursor = removedChunk.end
      session.record.truncatedBeforeCursor = true
    }
  }

  private getSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown PTY session: ${sessionId}`)
    }

    return session
  }

  private getWritableSession(sessionId: string): ManagedSession {
    const session = this.getSession(sessionId)
    if (session.record.state === 'running') {
      this.refreshRunningSession(sessionId, session)
    }
    if (session.record.state === 'closed' || session.record.state === 'exited') {
      throw new Error(`SESSION_ALREADY_CLOSED: ${sessionId}`)
    }
    return session
  }

  private applyDriverStatus(
    record: TerminalSessionRecord,
    status: ReturnType<PtyDriver['status']>,
  ): void {
    record.state = status.state
    record.exitCode = status.exitCode
    record.exitedAt = status.exitedAt
    record.pid = status.pid
    record.signal = status.signal
  }

  private cloneRecord(record: TerminalSessionRecord): TerminalSessionRecord {
    return {
      ...record,
    }
  }

  private validateSize(name: 'cols' | 'rows', value: number): number {
    const max = MAX_TERMINAL_SIZE[name]
    if (!Number.isInteger(value) || value <= 0 || value > max) {
      throw new Error(`Invalid terminal ${name}: ${value}. Must be between 1 and ${max}`)
    }
    return value
  }
}
