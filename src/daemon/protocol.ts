import { spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { createConnection, type Socket } from 'net'
import { dirname, join } from 'path'
import { isInBundledMode } from '../utils/bundledMode.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

export type JobState = 'running' | 'stopped' | 'exited'

/** Persisted at ~/.claude/jobs/<id>/state.json; survives the supervisor. */
export type JobRecord = {
  id: string
  sessionId: string
  name: string
  intent: string
  cwd: string
  /** CLI flags without the prompt and session arguments; reused on respawn. */
  args: string[]
  state: JobState
  /** The worker process, inside the PTY its host owns. */
  pid?: number
  /** The `--bg-pty-host` process that owns the worker's PTY. */
  hostPid?: number
  /** That host's socket: attach, logs, stop and detach talk to it directly. */
  ptySock?: string
  /** Set by a worker started with --worktree once it has created the worktree. */
  worktree?: JobWorktree
  exitCode?: number | null
  createdAt: string
  updatedAt: string
}

export type JobWorktree = {
  worktreePath: string
  worktreeBranch?: string
  originalCwd: string
  originalHeadCommit?: string
  hookBased?: boolean
}

export type SpawnRequest = {
  type: 'spawn'
  cwd: string
  flags: string[]
  prompt?: string
  name?: string
  env: Record<string, string>
  sessionId: string
  /** Continue an existing conversation instead of starting `sessionId` fresh. */
  resume: boolean
}

export type DaemonRequest =
  | SpawnRequest
  | { type: 'status' }
  | { type: 'respawn'; id: string; env: Record<string, string> }
  | { type: 'shutdown'; reapWorkers: boolean }

/** Requests to one worker's `--bg-pty-host`, on its ptySock. */
export type PtyHostRequest =
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'watch' }
  | { type: 'screen' }
  | { type: 'status' }
  | { type: 'input'; data: string }
  | { type: 'detach' }
  | { type: 'stop' }

export type DaemonStatus = {
  pid: number
  version: string
  startedAt: number
  origin: string
  socketPath: string
  running: number
}

export type DaemonResponse = {
  ok: boolean
  error?: string
  job?: JobRecord
  status?: DaemonStatus
  text?: string
}

/** Streamed frames on an attach connection (after the attach request). */
export type AttachFrame =
  | { type: 'attached'; modes: string }
  | { type: 'output'; data: string }
  | { type: 'detached' }
  | { type: 'exit'; state: JobState }

export type AttachClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

export function getJobsDir(): string {
  return join(getClaudeConfigHomeDir(), 'jobs')
}

export function getJobDir(id: string): string {
  return join(getJobsDir(), id)
}

export function getPtySockPath(id: string): string {
  if (process.platform === 'win32') return getPipePath(`pty-${id}`)
  return join(getSockDir(), 'pty', `${id}.sock`)
}

export function getDaemonLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.log')
}

/**
 * Unix socket paths are limited to ~104 bytes and macOS's os.tmpdir() is
 * long, so like official the sockets live under /tmp ($PREFIX/tmp on
 * Termux) keyed by a hash of the config dir.
 */
export function getSockDir(): string {
  const uid = process.getuid?.() ?? 0
  const base = process.env.TERMUX_VERSION && process.env.PREFIX ? join(process.env.PREFIX, 'tmp') : '/tmp'
  const hash = createHash('sha256').update(getClaudeConfigHomeDir()).digest('hex').slice(0, 8)
  return join(base, `cc-daemon-${uid}`, hash)
}

export function getControlSocketPath(): string {
  if (process.platform === 'win32') return getPipePath('control')
  return join(getSockDir(), 'control.sock')
}

const PIPE_NONCE = /^[0-9a-f]{16}$/

/**
 * Windows named pipes share one machine-wide namespace, so their names carry
 * a private nonce from <config>/daemon/pipe.key that other users can't read.
 */
function getPipePath(name: string): string {
  return `\\\\.\\pipe\\cc-daemon-${getPipeNonce()}-${name}`
}

function getPipeNonce(): string {
  const path = join(getClaudeConfigHomeDir(), 'daemon', 'pipe.key')
  for (let attempt = 0; attempt < 8; attempt++) {
    let existing: string | undefined
    try {
      existing = readFileSync(path, 'utf8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== undefined && PIPE_NONCE.test(existing)) return existing
    // Another process may have created the file and not yet written it.
    if (existing === '' && attempt < 3) continue
    const nonce = randomBytes(8).toString('hex')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(path, nonce, existing === undefined ? { flag: 'wx', mode: 0o600 } : { mode: 0o600 })
      return nonce
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('daemon pipe.key is not a valid nonce')
}

/** Keeps the pipe nonce out of messages, like official. */
export function redactPipeNonce(text: string): string {
  return text.replace(/cc-daemon-[0-9a-f]{16}/g, 'cc-daemon-*')
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** argv prefix that re-runs this Claude Code (compiled binary or bun + script). */
export function getSelfCommand(): string[] {
  return isInBundledMode() ? [process.execPath] : [process.execPath, process.argv[1]!]
}

export function writeFrame(socket: Socket, frame: unknown): void {
  socket.write(`${JSON.stringify(frame)}\n`)
}

/** Calls onFrame for each newline-delimited JSON frame received. */
export function readFrames(socket: Socket, onFrame: (frame: unknown) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        onFrame(JSON.parse(line))
      } catch {
        // Ignore malformed frames; the peer is our own binary.
      }
    }
  })
}

export function connectDaemon(timeoutMs = 1000, path = getControlSocketPath()): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out connecting to the background service'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export function daemonRequest(request: DaemonRequest, timeoutMs = 15_000): Promise<DaemonResponse> {
  return requestOnce(getControlSocketPath(), request, timeoutMs)
}

export type PtyHostResponse = { ok: boolean; text?: string; pid?: number; attached?: number }

/** One request to a worker's PTY host; rejects when the host is gone. */
export function hostRequest(
  sockPath: string,
  request: Exclude<PtyHostRequest, { type: 'attach' | 'watch' }>,
  timeoutMs = 10_000,
): Promise<PtyHostResponse> {
  return requestOnce(sockPath, request, timeoutMs)
}

async function requestOnce<T>(path: string, request: unknown, timeoutMs: number): Promise<T> {
  const socket = await connectDaemon(1000, path)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The background service did not answer'))
    }, timeoutMs)
    readFrames(socket, frame => {
      clearTimeout(timer)
      socket.end()
      resolve(frame as T)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    writeFrame(socket, request)
  })
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const response = await daemonRequest({ type: 'status' }, 2000)
    return response.ok
  } catch {
    return false
  }
}

/** Starts the supervisor (`claude daemon run`) detached if it is not answering. */
export async function ensureDaemon(origin: string, announce = false): Promise<boolean> {
  if (await isDaemonRunning()) return false
  if (announce) process.stderr.write('Starting background service…\n')
  const [command, ...entry] = getSelfCommand()
  const child = spawn(command!, [...entry, 'daemon', 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLAUDE_DAEMON_ORIGIN: origin },
  })
  child.unref()
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (await isDaemonRunning()) return true
  }
  throw new Error(`The background service did not start. See ${getDaemonLogPath()}`)
}

export async function readJobRecords(): Promise<JobRecord[]> {
  let ids: string[]
  try {
    ids = await readdir(getJobsDir())
  } catch {
    return []
  }
  const jobs: JobRecord[] = []
  for (const id of ids) {
    let job: JobRecord
    try {
      job = JSON.parse(await readFile(join(getJobDir(id), 'state.json'), 'utf8')) as JobRecord
    } catch {
      continue // Not a job directory.
    }
    try {
      job.worktree = JSON.parse(await readFile(join(getJobDir(id), 'worktree.json'), 'utf8')) as JobWorktree
    } catch {
      // Not started in a worktree.
    }
    // A host killed outright never recorded its worker's end.
    if (job.state === 'running' && job.hostPid && !isProcessAlive(job.hostPid)) {
      job.state = 'exited'
      job.pid = undefined
      job.hostPid = undefined
    }
    jobs.push(job)
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** State files are authoritative: workers outlive the supervisor. */
export const listJobs = readJobRecords

/** Inside a worker started with --worktree: lets `claude rm` clean the worktree up. */
export function recordJobWorktree(worktree: JobWorktree): void {
  const dir = process.env.CLAUDE_JOB_DIR
  if (!dir) return
  try {
    writeFileSync(join(dir, 'worktree.json'), JSON.stringify(worktree, null, 2), { mode: 0o600 })
  } catch {
    // Without it `claude rm` leaves the worktree in place.
  }
}

/** Resolves an id, id prefix, or part of the session name to one job. */
export function resolveJob(jobs: JobRecord[], query: string): JobRecord | string {
  const q = query.trim().toLowerCase()
  if (!q) return 'Give a session id or name.'
  const exact = jobs.find(job => job.id === q || job.sessionId === q)
  if (exact) return exact
  const matches = jobs.filter(
    job => job.id.startsWith(q) || job.name.toLowerCase().includes(q),
  )
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) return `No background session matches "${query}". Run \`claude agents\` to list them.`
  return `"${query}" matches ${matches.length} sessions: ${matches.map(job => `${job.id} (${job.name})`).join(', ')}`
}

/** Inside a background worker: return attached terminals to their shell. */
export function detachAttachedClients(): void {
  const sock = process.env.CLAUDE_PTY_SOCK
  if (sock) void hostRequest(sock, { type: 'detach' }).catch(() => {})
}

/** Stops a running job through its PTY host; resolves once the worker is gone. */
export async function stopJob(job: JobRecord): Promise<boolean> {
  if (!job.ptySock) return false
  try {
    const response = await hostRequest(job.ptySock, { type: 'stop' }, 15_000)
    return response.ok
  } catch {
    return false
  }
}
