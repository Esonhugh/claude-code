import { appendFileSync, chmodSync, lstatSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type Socket } from 'net'
import { dirname, join } from 'path'
import {
  applyTerminalOutput,
  createTerminalScreenRenderer,
  renderedPreview,
  resizeTerminalScreenRenderer,
  type TerminalScreenRenderer,
} from '../utils/pty/terminalScreenRenderer.js'
import {
  type AttachClientFrame,
  type DaemonRequest,
  type DaemonResponse,
  ensurePrivateDir,
  getControlSocketPath,
  getDaemonLogPath,
  getJobDir,
  getSelfCommand,
  type JobRecord,
  readFrames,
  readJobRecords,
  type SpawnRequest,
  writeFrame,
} from './protocol.js'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const STOP_GRACE_MS = 5000
const IDLE_EXIT_MS = 5000

type Worker = {
  job: JobRecord
  proc: Bun.Subprocess
  terminal: Bun.Terminal
  screen: TerminalScreenRenderer
  cols: number
  rows: number
  clients: Set<Socket>
  stopping: boolean
}

export function logDaemon(message: string): void {
  try {
    appendFileSync(getDaemonLogPath(), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Logging must never take the supervisor down.
  }
}

function saveJob(job: JobRecord): void {
  job.updatedAt = new Date().toISOString()
  const dir = getJobDir(job.id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(job, null, 2), { mode: 0o600 })
}

function saveScreen(worker: Worker): void {
  try {
    writeFileSync(join(getJobDir(worker.job.id), 'screen.txt'), `${renderedPreview(worker.screen)}\n`, { mode: 0o600 })
  } catch {
    // Best effort: logs falls back to "no output recorded".
  }
}

/** Terminal modes the worker switched on at startup, replayed to a new attach. */
function terminalModes(screen: TerminalScreenRenderer): string {
  const { terminal } = screen
  const modes = terminal.modes
  let out = terminal.buffer.active.type === 'alternate' ? '\x1b[?1049h' : ''
  if (modes.bracketedPasteMode) out += '\x1b[?2004h'
  if (modes.sendFocusMode) out += '\x1b[?1004h'
  switch (modes.mouseTrackingMode) {
    case 'x10':
    case 'vt200':
      out += '\x1b[?1000h\x1b[?1006h'
      break
    case 'drag':
      out += '\x1b[?1002h\x1b[?1006h'
      break
    case 'any':
      out += '\x1b[?1003h\x1b[?1006h'
      break
  }
  return out
}

/** Refuses a socket directory another user could have planted or can write to. */
function preparePrivateSocketDir(dir: string): void {
  ensurePrivateDir(dir)
  const info = lstatSync(dir)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`Refusing to use ${dir}: not a directory owned by this user`)
  }
  chmodSync(dir, 0o700)
}

export async function runSupervisor(): Promise<void> {
  const socketPath = getControlSocketPath()
  preparePrivateSocketDir(dirname(dirname(socketPath)))
  preparePrivateSocketDir(dirname(socketPath))
  try {
    unlinkSync(socketPath)
  } catch {
    // No stale socket.
  }

  const startedAt = Date.now()
  const origin = process.env.CLAUDE_DAEMON_ORIGIN ?? 'started with `claude daemon run`'
  const workers = new Map<string, Worker>()
  const connections = new Set<Socket>()
  let idleSince = Date.now()

  // A previous supervisor that died took its PTYs (and so its workers) with it.
  for (const job of await readJobRecords()) {
    if (job.state === 'running') {
      job.state = 'exited'
      job.pid = undefined
      saveJob(job)
    }
  }

  function spawnWorker(job: JobRecord, args: string[], env: Record<string, string>): Worker {
    const cols = DEFAULT_COLS
    const rows = DEFAULT_ROWS
    const screen = createTerminalScreenRenderer(cols, rows)
    const clients = new Set<Socket>()
    const proc = Bun.spawn([...getSelfCommand(), ...args], {
      cwd: job.cwd,
      env: {
        ...env,
        CLAUDE_CODE_SESSION_KIND: 'bg',
        CLAUDE_BG_BACKEND: 'daemon',
        CLAUDE_JOB_ID: job.id,
        CLAUDE_JOB_DIR: getJobDir(job.id),
        // Fullscreen repaints the whole screen on resize, which is how an
        // attach redraws the session.
        CLAUDE_CODE_NO_FLICKER: env.CLAUDE_CODE_NO_FLICKER ?? '1',
        TERM: env.TERM ?? 'xterm-256color',
      },
      terminal: {
        cols,
        rows,
        data(_terminal, data) {
          const text = Buffer.from(data).toString('utf8')
          applyTerminalOutput(screen, text)
          const encoded = Buffer.from(data).toString('base64')
          for (const client of clients) writeFrame(client, { type: 'output', data: encoded })
        },
      },
    })
    const worker: Worker = { job, proc, terminal: proc.terminal!, screen, cols, rows, clients, stopping: false }
    job.state = 'running'
    job.pid = proc.pid
    job.exitCode = undefined
    saveJob(job)
    workers.set(job.id, worker)
    logDaemon(`[bg] spawned ${job.id} pid=${proc.pid}`)

    void proc.exited.then(code => {
      job.state = worker.stopping ? 'stopped' : 'exited'
      job.exitCode = code
      job.pid = undefined
      saveScreen(worker)
      saveJob(job)
      workers.delete(job.id)
      logDaemon(`[bg] ${job.state} ${job.id} code=${code}`)
      for (const client of clients) {
        writeFrame(client, { type: 'exit', job })
        client.end()
      }
      idleSince = Date.now()
    })
    return worker
  }

  function stopWorker(worker: Worker): Promise<void> {
    worker.stopping = true
    worker.proc.kill('SIGTERM')
    worker.proc.kill('SIGCONT')
    const timer = setTimeout(() => worker.proc.kill('SIGKILL'), STOP_GRACE_MS)
    return worker.proc.exited.then(() => clearTimeout(timer))
  }

  async function handleSpawn(request: SpawnRequest): Promise<DaemonResponse> {
    const id = request.sessionId.slice(0, 8)
    if (workers.has(id)) return { ok: false, error: `Session ${id} is already running in the background.` }
    const now = new Date().toISOString()
    const intent = request.prompt ?? ''
    const job: JobRecord = {
      id,
      sessionId: request.sessionId,
      name:
        request.name ||
        intent.split('\n')[0]!.slice(0, 60) ||
        (request.resume ? 'resumed session' : 'background session'),
      intent,
      cwd: request.cwd,
      args: request.flags,
      state: 'running',
      createdAt: now,
      updatedAt: now,
    }
    const sessionArgs = request.resume
      ? ['--resume', request.sessionId]
      : ['--session-id', request.sessionId]
    spawnWorker(job, [...sessionArgs, ...request.flags, ...(request.prompt ? [request.prompt] : [])], request.env)
    return { ok: true, job }
  }

  async function handle(request: DaemonRequest, socket: Socket): Promise<DaemonResponse | null> {
    switch (request.type) {
      case 'status':
        return {
          ok: true,
          status: {
            pid: process.pid,
            version: MACRO.VERSION,
            startedAt,
            origin,
            socketPath,
            running: workers.size,
            attached: [...workers.values()].reduce((n, w) => n + w.clients.size, 0),
          },
        }
      case 'list':
        return { ok: true, jobs: await readJobRecords() }
      case 'spawn':
        return handleSpawn(request)
      case 'logs': {
        const worker = workers.get(request.id)
        return worker ? { ok: true, text: renderedPreview(worker.screen) } : { ok: false, error: 'not running' }
      }
      case 'stop': {
        const worker = workers.get(request.id)
        if (!worker) return { ok: false, error: `Session ${request.id} is not running.` }
        await stopWorker(worker)
        return { ok: true, job: worker.job }
      }
      case 'respawn': {
        const job = (await readJobRecords()).find(j => j.id === request.id)
        if (!job) return { ok: false, error: `No background session ${request.id}.` }
        const running = workers.get(job.id)
        if (running) await stopWorker(running)
        spawnWorker(job, ['--resume', job.sessionId, ...job.args], request.env)
        return { ok: true, job }
      }
      case 'rm': {
        const running = workers.get(request.id)
        if (running) await stopWorker(running)
        rmSync(getJobDir(request.id), { recursive: true, force: true })
        logDaemon(`[bg] removed ${request.id}`)
        return { ok: true }
      }
      case 'detach': {
        const worker = workers.get(request.id)
        for (const client of worker?.clients ?? []) {
          writeFrame(client, { type: 'detached' })
          client.end()
        }
        return { ok: true }
      }
      case 'shutdown':
        setTimeout(() => void shutdown(), 0)
        return { ok: true }
      case 'attach': {
        const worker = workers.get(request.id)
        if (!worker) {
          writeFrame(socket, { type: 'error', error: `Session ${request.id} is not running.` })
          socket.end()
          return null
        }
        attachClient(worker, socket, request.cols, request.rows)
        return null
      }
    }
  }

  function attachClient(worker: Worker, socket: Socket, cols: number, rows: number): void {
    worker.clients.add(socket)
    socket.on('close', () => worker.clients.delete(socket))
    writeFrame(socket, { type: 'attached', job: worker.job, modes: terminalModes(worker.screen) })
    const resize = (c: number, r: number) => {
      worker.cols = c
      worker.rows = r
      worker.terminal.resize(c, r)
      resizeTerminalScreenRenderer(worker.screen, c, r)
    }
    // A resize makes the fullscreen renderer repaint everything.
    if (cols === worker.cols && rows === worker.rows) {
      resize(cols, Math.max(2, rows - 1))
      setTimeout(() => resize(cols, rows), 50)
    } else {
      resize(cols, rows)
    }
    readFrames(socket, raw => {
      const frame = raw as AttachClientFrame
      if (frame.type === 'input') worker.terminal.write(Buffer.from(frame.data, 'base64'))
      else if (frame.type === 'resize' && frame.cols > 0 && frame.rows > 0) resize(frame.cols, frame.rows)
    })
  }

  const server = createServer(socket => {
    connections.add(socket)
    socket.on('close', () => {
      connections.delete(socket)
      idleSince = Date.now()
    })
    socket.on('error', () => {})
    let first = true
    readFrames(socket, raw => {
      if (!first) return
      first = false
      void handle(raw as DaemonRequest, socket)
        .then(response => {
          if (response) {
            writeFrame(socket, response)
            socket.end()
          }
        })
        .catch(error => {
          writeFrame(socket, { ok: false, error: String(error) })
          socket.end()
        })
    })
  })

  async function shutdown(): Promise<void> {
    clearInterval(idleTimer)
    await Promise.all([...workers.values()].map(stopWorker))
    server.close()
    try {
      unlinkSync(socketPath)
    } catch {
      // Already gone.
    }
    logDaemon(`[supervisor] exit pid=${process.pid}`)
    process.exit(0)
  }

  // Runs on demand: exits once no session is running and no client is connected.
  const idleTimer = setInterval(() => {
    if (workers.size > 0 || connections.size > 0) {
      idleSince = Date.now()
      return
    }
    if (Date.now() - idleSince >= IDLE_EXIT_MS) void shutdown()
  }, 1000)

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600)
      resolve()
    })
  })
  logDaemon(`[supervisor] start version=${MACRO.VERSION} pid=${process.pid} origin=${origin}`)
  await new Promise(() => {})
}
