import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import type { SpawnSessionOptions } from './backends/dangerousBackend.js'
import type { ServerLogger } from './serverLog.js'
import type { SessionInfo } from './types.js'

export type SessionBackend = {
  spawn: (options: SpawnSessionOptions) => ChildProcess
}

/** The WebSocket side of a session (Bun's ServerWebSocket satisfies this). */
export type SessionSocket = {
  send: (data: string) => unknown
  close: (code?: number, reason?: string) => void
}

type Session = SessionInfo & {
  process: ChildProcess
  socket: SessionSocket | null
  /** stdout lines produced while no client is attached. */
  pending: string[]
  /** Each task's `system/task_*` lines, for a client that attaches later. */
  taskLines?: Map<string, string[]>
  idleTimer?: ReturnType<typeof setTimeout>
  exited: Promise<void>
}

// Bounds memory for a detached session whose child keeps printing.
const MAX_PENDING_LINES = 1000
const MAX_REPLAYED_TASKS = 200
const KILL_GRACE_MS = 5000

export class SessionManagerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SessionManagerError'
  }
}

/** Keeps a task's lines in order, with only its latest progress snapshot. */
function recordTaskLine(taskLines: Map<string, string[]>, line: string): void {
  if (!line.includes('"subtype":"task_')) return
  let msg: { type?: unknown; subtype?: unknown; task_id?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (
    msg.type !== 'system' ||
    typeof msg.subtype !== 'string' ||
    !msg.subtype.startsWith('task_') ||
    typeof msg.task_id !== 'string'
  ) {
    return
  }
  const lines = taskLines.get(msg.task_id) ?? []
  const kept =
    msg.subtype === 'task_progress'
      ? lines.filter(l => !l.includes('"subtype":"task_progress"'))
      : lines
  taskLines.set(msg.task_id, [...kept, line])
  if (taskLines.size > MAX_REPLAYED_TASKS) {
    taskLines.delete(taskLines.keys().next().value!)
  }
}

/**
 * Owns one child process per session and relays newline-delimited
 * stream-json between it and at most one attached WebSocket.
 */
export class SessionManager {
  private sessions = new Map<string, Session>()
  private idleTimeoutMs: number
  private maxSessions: number
  private logger?: ServerLogger
  private replayTasks: boolean

  constructor(
    private backend: SessionBackend,
    options: {
      idleTimeoutMs?: number
      maxSessions?: number
      logger?: ServerLogger
      /**
       * Replay each task's `system/task_*` lines to every newly attached
       * client, so a reloaded page can rebuild its task list (claude web).
       */
      replayTasks?: boolean
    } = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0
    this.maxSessions = options.maxSessions ?? 0
    this.logger = options.logger
    this.replayTasks = options.replayTasks ?? false
  }

  create({
    cwd,
    permissionMode,
    model,
    resume,
    sessionKey,
  }: {
    cwd: string
    permissionMode?: string
    model?: string
    /** Transcript id to continue; reuses a running session with that id. */
    resume?: string
    sessionKey?: string
  }): SessionInfo {
    if (resume) {
      const running = this.sessions.get(resume)
      if (running) return running
    }
    if (sessionKey) {
      for (const session of this.sessions.values()) {
        if (session.sessionKey === sessionKey) return session
      }
    }
    if (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) {
      throw new SessionManagerError(
        `Maximum number of sessions (${this.maxSessions}) reached`,
        503,
      )
    }

    const id = resume ?? randomUUID()
    const child = this.backend.spawn({
      sessionId: id,
      cwd,
      permissionMode,
      ...(model && { model }),
      ...(resume && { resume: true }),
    })
    const session: Session = {
      id,
      status: 'detached',
      createdAt: Date.now(),
      workDir: cwd,
      process: child,
      sessionKey,
      socket: null,
      pending: [],
      ...(this.replayTasks && { taskLines: new Map() }),
      exited: new Promise(resolve => {
        child.once('close', () => resolve())
      }),
    }
    this.sessions.set(id, session)

    createInterface({ input: child.stdout! }).on('line', line => {
      if (!line.trim()) return
      if (session.taskLines) recordTaskLine(session.taskLines, line)
      if (session.socket) {
        session.socket.send(line + '\n')
        return
      }
      session.pending.push(line)
      if (session.pending.length > MAX_PENDING_LINES) session.pending.shift()
    })
    createInterface({ input: child.stderr! }).on('line', line => {
      this.logger?.warn(`session ${id} stderr: ${line}`)
    })
    // Writes after the child exits fail with EPIPE; exit is handled below.
    child.stdin!.on('error', () => {})
    child.once('error', err => {
      this.logger?.error(`session ${id} failed to start: ${err.message}`)
      this.remove(session, 1011, 'session process failed to start')
    })
    // 'close' (not 'exit') so every stdout line is relayed before the socket
    // is closed.
    child.once('close', (code, signal) => {
      this.logger?.info(
        `session ${id} exited (${signal ?? `code ${code ?? 'unknown'}`})`,
      )
      const clean = code === 0 || session.status === 'stopping'
      this.remove(session, clean ? 1000 : 1011, 'session process exited')
    })

    this.logger?.info(
      `session ${id} created in ${cwd}${permissionMode ? ` (permission mode ${permissionMode})` : ''}`,
    )
    this.startIdleTimer(session)
    return session
  }

  list(): (SessionInfo & { attached: boolean })[] {
    return [...this.sessions.values()].map(session => ({
      ...session,
      attached: !!session.socket,
    }))
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  canAttach(id: string): boolean {
    const session = this.sessions.get(id)
    return !!session && !session.socket
  }

  attach(id: string, socket: SessionSocket): boolean {
    const session = this.sessions.get(id)
    if (!session || session.socket) return false
    clearTimeout(session.idleTimer)
    session.socket = socket
    session.status = 'running'
    // Pending lines may repeat some of these; task events fold idempotently.
    for (const lines of session.taskLines?.values() ?? []) {
      for (const line of lines) socket.send(line + '\n')
    }
    for (const line of session.pending.splice(0)) socket.send(line + '\n')
    this.logger?.info(`session ${id} attached`)
    return true
  }

  detach(id: string, socket: SessionSocket): void {
    const session = this.sessions.get(id)
    if (!session || session.socket !== socket) return
    session.socket = null
    session.status = 'detached'
    this.logger?.info(`session ${id} detached`)
    this.startIdleTimer(session)
  }

  write(id: string, data: string): void {
    const stdin = this.sessions.get(id)?.process.stdin
    if (!stdin || stdin.destroyed) return
    for (const line of data.split('\n')) {
      if (line.trim()) stdin.write(line + '\n')
    }
  }

  async destroy(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    session.status = 'stopping'
    clearTimeout(session.idleTimer)
    session.process.stdin?.end()
    session.process.kill('SIGTERM')
    const forceKill = setTimeout(
      () => session.process.kill('SIGKILL'),
      KILL_GRACE_MS,
    )
    await session.exited
    clearTimeout(forceKill)
    return true
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.destroy(id)))
  }

  private startIdleTimer(session: Session): void {
    clearTimeout(session.idleTimer)
    if (this.idleTimeoutMs <= 0) return
    session.idleTimer = setTimeout(() => {
      this.logger?.info(`session ${session.id} idle timeout`)
      void this.destroy(session.id)
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private remove(session: Session, code: number, reason: string): void {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    clearTimeout(session.idleTimer)
    session.status = 'stopped'
    const socket = session.socket
    session.socket = null
    socket?.close(code, reason)
  }
}
