import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { createConnection, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
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
  pid?: number
  exitCode?: number | null
  createdAt: string
  updatedAt: string
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
  | { type: 'list' }
  | { type: 'status' }
  | { type: 'logs'; id: string }
  | { type: 'stop'; id: string }
  | { type: 'respawn'; id: string; env: Record<string, string> }
  | { type: 'rm'; id: string }
  | { type: 'detach'; id: string }
  | { type: 'shutdown' }
  | { type: 'attach'; id: string; cols: number; rows: number }

export type DaemonStatus = {
  pid: number
  version: string
  startedAt: number
  origin: string
  socketPath: string
  running: number
  attached: number
}

export type DaemonResponse = {
  ok: boolean
  error?: string
  job?: JobRecord
  jobs?: JobRecord[]
  status?: DaemonStatus
  text?: string
}

/** Streamed frames on an attach connection (after the attach request). */
export type AttachFrame =
  | { type: 'attached'; job: JobRecord; modes: string }
  | { type: 'output'; data: string }
  | { type: 'detached' }
  | { type: 'exit'; job: JobRecord }
  | { type: 'error'; error: string }

export type AttachClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

export function getJobsDir(): string {
  return join(getClaudeConfigHomeDir(), 'jobs')
}

export function getJobDir(id: string): string {
  return join(getJobsDir(), id)
}

export function getDaemonLogPath(): string {
  return join(getClaudeConfigHomeDir(), 'daemon.log')
}

/**
 * Unix socket paths are limited to ~104 bytes, so the socket lives under
 * the temp dir keyed by a hash of the config dir (like official's
 * /tmp/cc-daemon-<uid>/<hash>/control.sock).
 */
export function getControlSocketPath(): string {
  const uid = process.getuid?.() ?? 0
  const hash = createHash('sha256').update(getClaudeConfigHomeDir()).digest('hex').slice(0, 8)
  return join(tmpdir(), `cc-daemon-${uid}`, hash, 'control.sock')
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

export function connectDaemon(timeoutMs = 1000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(getControlSocketPath())
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

export async function daemonRequest(
  request: Exclude<DaemonRequest, { type: 'attach' }>,
  timeoutMs = 15_000,
): Promise<DaemonResponse> {
  const socket = await connectDaemon()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The background service did not answer'))
    }, timeoutMs)
    readFrames(socket, frame => {
      clearTimeout(timer)
      socket.end()
      resolve(frame as DaemonResponse)
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
export async function ensureDaemon(origin: string): Promise<boolean> {
  if (await isDaemonRunning()) return false
  const [command, ...entry] = getSelfCommand()
  const child = spawn(command!, [...entry, 'daemon', 'run'], {
    detached: true,
    stdio: 'ignore',
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
    try {
      jobs.push(JSON.parse(await readFile(join(getJobDir(id), 'state.json'), 'utf8')) as JobRecord)
    } catch {
      // Not a job directory.
    }
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Jobs from the live supervisor, or from disk when it is not running. */
export async function listJobs(): Promise<JobRecord[]> {
  try {
    const response = await daemonRequest({ type: 'list' }, 3000)
    if (response.ok && response.jobs) return response.jobs
  } catch {
    // Supervisor not running: state files are authoritative.
  }
  return readJobRecords()
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
  const id = process.env.CLAUDE_JOB_ID
  if (id) void daemonRequest({ type: 'detach', id }).catch(() => {})
}
