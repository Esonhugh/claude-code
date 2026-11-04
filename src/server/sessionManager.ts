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
  /** Unanswered `can_use_tool` requests by request id, for a client that attaches later. */
  asks: Map<string, string>
  /** The latest `system/init` (permission mode kept current), for a client that attaches later (replayTasks only). */
  init?: string
  idleTimer?: ReturnType<typeof setTimeout>
  exited: Promise<void>
  spawnOptions: SpawnSessionOptions
  /** A turn is in progress (set by a written user message, cleared by `session_state_changed` idle). */
  busy: boolean
  /** Options for a restart waiting on the current turn to end. */
  restartWith?: SpawnSessionOptions
  /** Lines written while the process is being replaced. */
  queued?: string[]
  /** When a channel was last turned on (`--channels` at spawn, or channel_enable). */
  channelSince?: number
  /** channel_enable requests waiting for their response, with their channel key. */
  channelRequests?: Map<string, string>
  /** Channels this process listens on (channelKey) → when they were turned on. */
  channels: Map<string, number>
  /** The server's own control requests (`request`) waiting for their response. */
  ownRequests?: Map<string, (response: Record<string, unknown>) => void>
}

/**
 * One key per channel, from a `--channels` entry (`plugin:<name>@<marketplace>`)
 * or a channel_enable server name (`plugin:<name>:<server>`, or a plain MCP server).
 */
export function channelKey(entry: string): string {
  const plugin = /^plugin:([^:@]+)[:@]/.exec(entry)
  return plugin ? `plugin:${plugin[1]}` : entry
}

function spawnChannels(channels: string[] | undefined, at: number): Map<string, number> {
  return new Map((channels ?? []).map(entry => [channelKey(entry), at]))
}

/** Sees every stream-json line of every session (claude web keeps a project's tasks from them). */
export type SessionObserver = {
  /** A line from the child's stdout (`child`) or written to its stdin by the client (`client`). */
  line?: (sessionId: string, line: string, from: 'child' | 'client') => void
  /** The session's process ended for good (not a restart). */
  exit?: (sessionId: string) => void
}

export type CoordinatorOptions = Pick<
  SpawnSessionOptions,
  'systemPrompt' | 'appendSystemPrompt' | 'env'
>

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

function closed(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.once('close', () => resolve())
  })
}

/** Keeps a task's lines in order, with only its latest progress snapshot. */
/** Keeps a `can_use_tool` request until it is answered (`control_response`) or cancelled. */
/** A channel_enable request (from the client) and its success (from the child) turn a channel on. */
function recordChannelLine(session: Session, line: string): void {
  let msg: {
    type?: string
    request_id?: unknown
    request?: { serverName?: unknown }
    response?: { subtype?: unknown; request_id?: unknown }
  }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'control_request' && typeof msg.request_id === 'string' && typeof msg.request?.serverName === 'string') {
    ;(session.channelRequests ??= new Map()).set(msg.request_id, channelKey(msg.request.serverName))
  } else if (msg.type === 'control_response' && typeof msg.response?.request_id === 'string') {
    const key = session.channelRequests?.get(msg.response.request_id)
    if (key === undefined) return
    session.channelRequests!.delete(msg.response.request_id)
    if (msg.response.subtype !== 'success') return
    session.channelSince = Date.now()
    session.channels.set(key, session.channelSince)
  }
}

/** Resolves a response to one of the server's own requests; such a line is not relayed. */
function takeOwnResponse(session: Session, line: string): boolean {
  let response: Record<string, unknown> | undefined
  try {
    response = (JSON.parse(line) as { response?: Record<string, unknown> }).response
  } catch {
    return false
  }
  const id = typeof response?.request_id === 'string' ? response.request_id : undefined
  const resolve = id === undefined ? undefined : session.ownRequests?.get(id)
  if (!resolve) return false
  session.ownRequests!.delete(id!)
  resolve(response!)
  return true
}

function recordAsk(asks: Map<string, string>, line: string): void {
  let msg: { type?: string; request_id?: unknown; request?: { subtype?: unknown }; response?: { request_id?: unknown } }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool' && typeof msg.request_id === 'string') {
    asks.set(msg.request_id, line)
  } else if (msg.type === 'control_cancel_request' && typeof msg.request_id === 'string') {
    asks.delete(msg.request_id)
  } else if (msg.type === 'control_response' && typeof msg.response?.request_id === 'string') {
    asks.delete(msg.response.request_id)
  }
}

/** The init line to replay: a new init replaces it, a mode change (`system/status`) is folded into it. */
function recordInit(init: string | undefined, line: string): string | undefined {
  const isInit = line.includes('"subtype":"init"')
  if (!isInit && !(init && line.includes('"subtype":"status"') && line.includes('"permissionMode"'))) return init
  let msg: { type?: unknown; subtype?: unknown; permissionMode?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return init
  }
  if (msg.type !== 'system') return init
  if (msg.subtype === 'init') return line
  if (msg.subtype !== 'status' || typeof msg.permissionMode !== 'string' || !init) return init
  try {
    return JSON.stringify({ ...JSON.parse(init), permissionMode: msg.permissionMode })
  } catch {
    return init
  }
}

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
  private observer?: SessionObserver

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

  observe(observer: SessionObserver): void {
    this.observer = observer
  }

  create({
    cwd,
    permissionMode,
    model,
    effort,
    resume,
    sessionKey,
    channels,
    settings,
    coordinator,
  }: {
    cwd: string
    permissionMode?: string
    model?: string
    effort?: string
    /** Transcript id to continue; reuses a running session with that id. */
    resume?: string
    sessionKey?: string
    /** `--channels` entries for the new session's process. */
    channels?: string[]
    /** `--settings` JSON: the session's own plugins, MCP servers and hooks. */
    settings?: string
    /** Prompt flags and environment of a project's coordinator. */
    coordinator?: CoordinatorOptions
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
    const spawnOptions: SpawnSessionOptions = {
      sessionId: id,
      cwd,
      permissionMode,
      ...(model && { model }),
      ...(effort && { effort }),
      ...(resume && { resume: true }),
      ...(channels?.length && { channels }),
      ...(settings && { settings }),
      ...coordinator,
    }
    const child = this.backend.spawn(spawnOptions)
    const now = Date.now()
    const session: Session = {
      id,
      status: 'detached',
      createdAt: Date.now(),
      workDir: cwd,
      process: child,
      sessionKey,
      socket: null,
      pending: [],
      asks: new Map(),
      ...(this.replayTasks && { taskLines: new Map() }),
      exited: closed(child),
      spawnOptions,
      busy: false,
      ...(channels?.length && { channelSince: now }),
      channels: spawnChannels(channels, now),
    }
    this.sessions.set(id, session)
    this.wire(session, child)

    this.logger?.info(
      `session ${id} created in ${cwd}${permissionMode ? ` (permission mode ${permissionMode})` : ''}`,
    )
    this.startIdleTimer(session)
    return session
  }

  /**
   * Respawns a session's process with `--resume` and these flags (in place
   * of the ones it started with), keeping the attached socket. Waits for a
   * running turn to end first.
   */
  restart(
    id: string,
    options: Pick<SpawnSessionOptions, 'permissionMode' | 'model' | 'effort'> & {
      coordinator?: CoordinatorOptions
      /** New `--channels` and `--settings` (a changed session config); kept when left out. */
      flags?: Pick<SpawnSessionOptions, 'channels' | 'settings'>
    },
  ): 'restarted' | 'pending' | undefined {
    const session = this.sessions.get(id)
    if (!session || session.status === 'stopping') return undefined
    const { sessionId, cwd } = session.spawnOptions
    const { channels, settings } = options.flags ?? session.spawnOptions
    session.restartWith = {
      sessionId,
      cwd,
      ...(channels?.length && { channels }),
      ...(settings && { settings }),
      ...(options.permissionMode && { permissionMode: options.permissionMode }),
      ...(options.model && { model: options.model }),
      ...(options.effort && { effort: options.effort }),
      ...options.coordinator,
      resume: true,
    }
    if (session.busy || session.queued) return 'pending'
    void this.respawn(session)
    return 'restarted'
  }

  private async respawn(session: Session): Promise<void> {
    const options = session.restartWith!
    session.restartWith = undefined
    session.queued = []
    this.logger?.info(`session ${session.id} restarting`)
    session.process.stdin?.end()
    session.process.kill('SIGTERM')
    const forceKill = setTimeout(() => session.process.kill('SIGKILL'), KILL_GRACE_MS)
    await session.exited
    clearTimeout(forceKill)
    const queued = session.queued
    session.queued = undefined
    if (this.sessions.get(session.id) !== session) return
    if (session.status === 'stopping') {
      this.observer?.exit?.(session.id)
      this.remove(session, 1000, 'session process exited')
      return
    }
    const child = this.backend.spawn(options)
    session.process = child
    session.exited = closed(child)
    session.spawnOptions = options
    session.busy = false
    session.asks.clear()
    session.channelRequests = undefined
    session.channels = spawnChannels(options.channels, Date.now())
    if (options.channels?.length) session.channelSince = Date.now()
    for (const resolve of session.ownRequests?.values() ?? []) resolve({ subtype: 'error', error: 'session restarted' })
    session.ownRequests = undefined
    this.wire(session, child)
    this.write(session.id, queued.join('\n'))
    if (session.restartWith && !session.busy) void this.respawn(session)
  }

  private wire(session: Session, child: ChildProcess): void {
    const id = session.id
    createInterface({ input: child.stdout! }).on('line', line => {
      if (!line.trim()) return
      if (session.taskLines) {
        recordTaskLine(session.taskLines, line)
        session.init = recordInit(session.init, line)
      }
      if (line.includes('"can_use_tool"') || line.includes('"control_cancel_request"')) recordAsk(session.asks, line)
      if (session.channelRequests?.size && line.includes('"type":"control_response"')) recordChannelLine(session, line)
      if (session.ownRequests?.size && line.includes('"type":"control_response"') && takeOwnResponse(session, line)) return
      if (line.includes('"subtype":"session_state_changed"') && session.process === child) {
        this.trackTurn(session, line)
      } else if (
        // Without session state events (any session but a coordinator), a result ends the turn.
        session.busy &&
        session.process === child &&
        !session.spawnOptions.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS &&
        line.startsWith('{"type":"result"')
      ) {
        session.busy = false
        if (session.restartWith && !session.queued) void this.respawn(session)
      }
      this.observer?.line?.(id, line, 'child')
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
      if (session.process !== child) return
      this.observer?.exit?.(id)
      this.remove(session, 1011, 'session process failed to start')
    })
    // 'close' (not 'exit') so every stdout line is relayed before the socket
    // is closed.
    child.once('close', (code, signal) => {
      this.logger?.info(
        `session ${id} exited (${signal ?? `code ${code ?? 'unknown'}`})`,
      )
      if (session.process !== child || session.queued) return
      this.observer?.exit?.(id)
      const clean = code === 0 || session.status === 'stopping'
      this.remove(session, clean ? 1000 : 1011, 'session process exited')
    })
  }

  private trackTurn(session: Session, line: string): void {
    let state: unknown
    try {
      state = (JSON.parse(line) as { state?: unknown }).state
    } catch {
      return
    }
    if (typeof state !== 'string') return
    session.busy = state !== 'idle'
    if (!session.busy && session.restartWith && !session.queued) void this.respawn(session)
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

  /** The session's current `--channels`/`--settings`, and the model and mode from its latest init. */
  current(id: string): (Pick<SpawnSessionOptions, 'channels' | 'settings' | 'model' | 'permissionMode' | 'effort'>) | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const { channels, settings, model, permissionMode, effort } = session.spawnOptions
    let init: { model?: unknown; permissionMode?: unknown } = {}
    try {
      init = session.init ? JSON.parse(session.init) : {}
    } catch {
      // A broken init line: keep the spawn options.
    }
    return {
      channels,
      settings,
      model: typeof init.model === 'string' ? init.model : model,
      permissionMode: typeof init.permissionMode === 'string' ? init.permissionMode : permissionMode,
      effort,
    }
  }

  /** Live sessions listening on a channel (see channelKey), oldest first. */
  channelSessions(key: string): { id: string; since: number }[] {
    return [...this.sessions.values()]
      .flatMap(s => {
        const since = s.channels.get(key)
        return since === undefined || s.status === 'stopping' ? [] : [{ id: s.id, since }]
      })
      .sort((a, b) => a.since - b.since)
  }

  /**
   * Sends the session's process a control request of the server's own (not
   * the page's); its response is not relayed. Resolves undefined on timeout.
   */
  request(id: string, request: Record<string, unknown>, timeoutMs = 3000): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(id)
    const stdin = session?.process.stdin
    if (!session || session.queued || !stdin || stdin.destroyed) return Promise.resolve(undefined)
    const requestId = `web-server-${randomUUID()}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        session.ownRequests?.delete(requestId)
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      ;(session.ownRequests ??= new Map()).set(requestId, response => {
        clearTimeout(timer)
        resolve(response)
      })
      stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n')
    })
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
    // A page that attaches after the first one has not seen the session's init (tools, skills, version).
    if (session.init && !session.pending.includes(session.init)) socket.send(session.init + '\n')
    // Pending lines may repeat some of these; task events fold idempotently.
    for (const lines of session.taskLines?.values() ?? []) {
      for (const line of lines) socket.send(line + '\n')
    }
    for (const line of session.asks.values()) {
      if (!session.pending.includes(line)) socket.send(line + '\n')
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
    const session = this.sessions.get(id)
    if (!session) return
    const lines = data.split('\n').filter(line => line.trim())
    if (session.queued) {
      session.queued.push(...lines)
      return
    }
    const stdin = session.process.stdin
    if (!stdin || stdin.destroyed) return
    for (const line of lines) {
      if (line.includes('"type":"user"')) session.busy = true
      if (line.includes('"type":"control_response"')) recordAsk(session.asks, line)
      if (line.includes('"subtype":"channel_enable"')) recordChannelLine(session, line)
      this.observer?.line?.(id, line, 'client')
      stdin.write(line + '\n')
    }
  }

  async destroy(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false
    session.status = 'stopping'
    session.restartWith = undefined
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
      // A detached coordinator keeps its workers running until its turn ends.
      if (session.busy && session.spawnOptions.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) {
        return this.startIdleTimer(session)
      }
      // The session that last turned a channel on holds the bot (a newer
      // channel server replaces an older one's poller); it keeps listening.
      // One still turning a channel on is about to take the bot over.
      if (session.channelRequests?.size) return this.startIdleTimer(session)
      if (session.channelSince && ![...this.sessions.values()].some(s => (s.channelSince ?? 0) > session.channelSince!)) {
        return this.startIdleTimer(session)
      }
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
