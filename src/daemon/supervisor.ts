import { appendFileSync, chmodSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type Socket } from 'net'
import { dirname, join } from 'path'
import {
  connectDaemon,
  type DaemonRequest,
  type DaemonResponse,
  ensurePrivateDir,
  getControlSocketPath,
  getDaemonLogPath,
  getJobDir,
  getPtySockPath,
  getSelfCommand,
  getSockDir,
  type JobRecord,
  readFrames,
  readJobRecords,
  type SpawnRequest,
  stopJob,
  writeFrame,
} from './protocol.js'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const HOST_START_MS = 5000
const IDLE_EXIT_MS = 5000

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
  // worktree.json belongs to the worker.
  const { worktree: _worktree, ...record } = job
  writeFileSync(join(dir, 'state.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
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
  // Windows named pipes have no directory.
  const posix = process.platform !== 'win32'
  if (posix) {
    const sockDir = getSockDir()
    preparePrivateSocketDir(dirname(sockDir))
    preparePrivateSocketDir(sockDir)
    preparePrivateSocketDir(join(sockDir, 'pty'))
  }
  try {
    unlinkSync(socketPath)
  } catch {
    // No stale socket.
  }

  const startedAt = Date.now()
  const origin = process.env.CLAUDE_DAEMON_ORIGIN ?? 'started with `claude daemon run`'
  // Jobs whose PTY host this supervisor is watching.
  const workers = new Map<string, JobRecord>()
  const connections = new Set<Socket>()
  let idleSince = Date.now()

  /** Follows a host until its worker exits; false when the host is gone. */
  async function watch(job: JobRecord): Promise<boolean> {
    let socket: Socket
    try {
      socket = await connectDaemon(1000, job.ptySock)
    } catch {
      return false
    }
    workers.set(job.id, job)
    socket.on('error', () => {})
    socket.on('close', () => {
      if (workers.get(job.id) !== job) return
      workers.delete(job.id)
      idleSince = Date.now()
      logDaemon(`[bg] ${job.id} ended`)
    })
    writeFrame(socket, { type: 'watch' })
    return true
  }

  // Workers outlive a supervisor stopped with --keep-workers: adopt them.
  for (const job of await readJobRecords()) {
    if (job.state !== 'running') continue
    if (await watch(job)) {
      logDaemon(`[bg] adopted ${job.id} host=${job.hostPid}`)
    } else {
      job.state = 'exited'
      job.pid = undefined
      job.hostPid = undefined
      saveJob(job)
    }
  }

  async function spawnWorker(job: JobRecord, args: string[], env: Record<string, string>): Promise<void> {
    const self = getSelfCommand()
    const ptySock = getPtySockPath(job.id)
    const dir = getJobDir(job.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const hostLog = openSync(join(dir, 'host.log'), 'a', 0o600)
    const host = Bun.spawn(
      [...self, '--bg-pty-host', ptySock, String(DEFAULT_COLS), String(DEFAULT_ROWS), '--', ...self, ...args],
      {
        cwd: job.cwd,
        env: {
          ...env,
          CLAUDE_CODE_SESSION_KIND: 'bg',
          CLAUDE_BG_BACKEND: 'daemon',
          CLAUDE_JOB_ID: job.id,
          CLAUDE_JOB_DIR: dir,
          // Fullscreen repaints the whole screen on resize, which is how an
          // attach redraws the session.
          CLAUDE_CODE_NO_FLICKER: env.CLAUDE_CODE_NO_FLICKER ?? '1',
          TERM: env.TERM ?? 'xterm-256color',
        },
        stdio: ['ignore', 'ignore', hostLog],
        detached: true,
        windowsHide: true,
      },
    )
    host.unref()
    job.state = 'running'
    job.hostPid = host.pid
    job.ptySock = ptySock
    job.pid = undefined
    job.exitCode = undefined
    saveJob(job)
    const deadline = Date.now() + HOST_START_MS
    while (!(await watch(job))) {
      if (Date.now() > deadline || host.exitCode !== null) {
        throw new Error(`The background session did not start. See ${join(dir, 'host.log')}`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    logDaemon(`[bg] spawned ${job.id} host=${host.pid}`)
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
    await spawnWorker(job, [...sessionArgs, ...request.flags, ...(request.prompt ? [request.prompt] : [])], request.env)
    return { ok: true, job }
  }

  /** A worker that made its worktree resumes inside it instead of making another. */
  function respawnArgs(job: JobRecord): { cwd: string; args: string[] } {
    if (!job.worktree) return { cwd: job.cwd, args: job.args }
    const args: string[] = []
    for (let i = 0; i < job.args.length; i++) {
      const arg = job.args[i]!
      if (arg === '--worktree' || arg === '-w') {
        if (job.args[i + 1] !== undefined && !job.args[i + 1]!.startsWith('-')) i++
        continue
      }
      if (arg.startsWith('--worktree=')) continue
      args.push(arg)
    }
    return { cwd: job.worktree.worktreePath, args }
  }

  async function handle(request: DaemonRequest): Promise<DaemonResponse> {
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
          },
        }
      case 'spawn':
        return handleSpawn(request)
      case 'respawn': {
        const job = (await readJobRecords()).find(j => j.id === request.id)
        if (!job) return { ok: false, error: `No background session ${request.id}.` }
        const running = workers.get(job.id)
        if (running) await stopJob(running)
        const { cwd, args } = respawnArgs(job)
        await spawnWorker({ ...job, cwd }, ['--resume', job.sessionId, ...args], request.env)
        return { ok: true, job: workers.get(job.id) ?? job }
      }
      case 'shutdown':
        setTimeout(() => void shutdown(request.reapWorkers), 0)
        return { ok: true, status: { pid: process.pid, version: MACRO.VERSION, startedAt, origin, socketPath, running: workers.size } }
    }
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
      void handle(raw as DaemonRequest)
        .then(response => {
          writeFrame(socket, response)
          socket.end()
        })
        .catch(error => {
          writeFrame(socket, { ok: false, error: error instanceof Error ? error.message : String(error) })
          socket.end()
        })
    })
  })

  async function shutdown(reapWorkers = true): Promise<void> {
    clearInterval(idleTimer)
    if (reapWorkers) await Promise.all([...workers.values()].map(stopJob))
    server.close()
    try {
      unlinkSync(socketPath)
    } catch {
      // Already gone.
    }
    logDaemon(`[supervisor] exit pid=${process.pid}${reapWorkers ? '' : ` (kept ${workers.size} workers)`}`)
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
      if (posix) chmodSync(socketPath, 0o600)
      resolve()
    })
  })
  logDaemon(`[supervisor] start version=${MACRO.VERSION} pid=${process.pid} origin=${origin}`)
  await new Promise(() => {})
}
