import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  type AttachFrame,
  connectDaemon,
  daemonRequest,
  ensureDaemon,
  getJobDir,
  type JobRecord,
  listJobs,
  readFrames,
  resolveJob,
  writeFrame,
} from '../daemon/protocol.js'
import { listAllLiveSessions } from '../utils/udsClient.js'

// Ctrl+Z, also as sent under the kitty keyboard protocol.
const DETACH_KEYS = ['\x1a', '\x1b[122;5u']

export function formatBackgroundedHint(id: string): string {
  return [
    `backgrounded · ${id}`,
    '  claude agents             list sessions',
    `  claude attach ${id.padEnd(11)} open in this terminal`,
    `  claude logs ${id.padEnd(13)} show recent output`,
    `  claude stop ${id.padEnd(13)} stop this session`,
  ].join('\n')
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // The worker decides these for itself.
  delete env.CLAUDE_CODE_SESSION_KIND
  delete env.CLAUDE_JOB_ID
  delete env.CLAUDE_JOB_DIR
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * Splits `claude --bg` argv into the flags a worker reuses, dropping
 * --bg/--background, the prompt, and the session arguments.
 */
export function splitBgArgs(
  argv: string[],
  prompt: string | undefined,
): { flags: string[]; resume?: string } {
  const flags: string[] = []
  let resume: string | undefined
  let promptRemoved = prompt === undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--bg' || arg === '--background') continue
    if (arg === '--resume' || arg === '-r' || arg === '--session-id') {
      if (arg !== '--session-id') resume = argv[i + 1]
      i++
      continue
    }
    if (arg.startsWith('--resume=')) {
      resume = arg.slice('--resume='.length)
      continue
    }
    if (!promptRemoved && arg === prompt) {
      promptRemoved = true
      continue
    }
    flags.push(arg)
  }
  return { flags, resume }
}

export async function spawnBackgroundSession(options: {
  cwd: string
  flags: string[]
  prompt?: string
  sessionId?: string
  name?: string
  origin: string
}): Promise<JobRecord> {
  await ensureDaemon(options.origin)
  const response = await daemonRequest({
    type: 'spawn',
    cwd: options.cwd,
    flags: options.flags,
    prompt: options.prompt,
    env: childEnv(),
    sessionId: options.sessionId ?? randomUUID(),
    name: options.name,
    resume: options.sessionId !== undefined,
  })
  if (!response.ok) throw new Error(response.error ?? 'The background service refused the request.')
  return response.job!
}

/** `claude --bg [prompt]`: start the session in a background worker and return. */
export async function handleBgFlag(
  prompt: string | undefined,
  argv: string[],
  name?: string,
): Promise<void> {
  const { flags, resume } = splitBgArgs(argv, prompt)
  if (flags.includes('-p') || flags.includes('--print')) {
    fail('--bg starts an interactive session in the background; it cannot be combined with -p/--print.')
  }
  try {
    const job = await spawnBackgroundSession({
      cwd: process.cwd(),
      flags,
      prompt,
      sessionId: resume,
      name,
      origin: `transient — started on-demand by \`claude --bg\` (pid ${process.pid}) in ${process.cwd()}`,
    })
    process.stdout.write(`${formatBackgroundedHint(job.id)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

async function findJob(query: string | undefined): Promise<JobRecord> {
  const job = resolveJob(await listJobs(), query ?? '')
  if (typeof job === 'string') fail(job)
  return job
}

export async function logsHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  let text: string | undefined
  if (job.state === 'running') {
    const response = await daemonRequest({ type: 'logs', id: job.id }).catch(() => null)
    if (response?.ok) text = response.text
  }
  text ??= await readFile(join(getJobDir(job.id), 'screen.txt'), 'utf8').catch(() => undefined)
  process.stdout.write(text?.trim() ? `${text.trimEnd()}\n` : `No output recorded for ${job.id}.\n`)
}

export async function stopHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  if (job.state !== 'running') {
    process.stdout.write(`${job.id} is not running (${job.state}).\n`)
    return
  }
  const response = await daemonRequest({ type: 'stop', id: job.id })
  if (!response.ok) fail(response.error ?? 'The background service refused the request.')
  process.stdout.write(`stopped ${job.id} · \`claude attach ${job.id}\` opens it again\n`)
}

export async function rmHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  await ensureDaemon('started by `claude rm`')
  const response = await daemonRequest({ type: 'rm', id: job.id })
  if (!response.ok) fail(response.error ?? 'The background service refused the request.')
  process.stdout.write(`removed ${job.id}\n`)
}

export async function respawnHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  await ensureDaemon('started by `claude respawn`')
  const response = await daemonRequest({ type: 'respawn', id: job.id, env: childEnv() })
  if (!response.ok) fail(response.error ?? 'The background service refused the request.')
  process.stdout.write(`respawned ${job.id}\n`)
}

export async function attachHandler(query?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("'claude attach' requires an interactive terminal.")
  }
  let job = await findJob(query)
  if (job.state !== 'running') {
    // A stopped session keeps its conversation: attaching resumes it.
    await ensureDaemon('started by `claude attach`')
    const response = await daemonRequest({ type: 'respawn', id: job.id, env: childEnv() })
    if (!response.ok) fail(response.error ?? 'The background service refused the request.')
    job = response.job!
  }
  const result = await attachToJob(job.id)
  process.stdout.write(`${result}\n`)
}

/** Proxies this terminal to the worker's PTY until detach or exit. */
export async function attachToJob(id: string): Promise<string> {
  const socket = await connectDaemon()
  const stdin = process.stdin
  const stdout = process.stdout
  let modes = ''
  const restore = () => {
    stdin.setRawMode?.(false)
    stdin.pause()
    stdin.removeListener('data', onInput)
    process.removeListener('SIGWINCH', onResize)
    // Undo the terminal modes the session had switched on.
    if (modes) stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1049l\x1b[?25h')
  }
  // stdin may already have an encoding set, so data can arrive as a string.
  const onInput = (data: Buffer | string) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    if (DETACH_KEYS.some(key => bytes.includes(key))) {
      socket.end()
      return
    }
    writeFrame(socket, { type: 'input', data: bytes.toString('base64') })
  }
  const onResize = () => {
    writeFrame(socket, { type: 'resize', cols: stdout.columns, rows: stdout.rows })
  }

  return new Promise(resolve => {
    let outcome = `detached from ${id} · \`claude attach ${id}\` to return`
    readFrames(socket, raw => {
      const frame = raw as AttachFrame
      switch (frame.type) {
        case 'attached':
          modes = frame.modes
          stdout.write(modes)
          stdin.setRawMode?.(true)
          stdin.resume()
          stdin.on('data', onInput)
          process.on('SIGWINCH', onResize)
          break
        case 'output':
          stdout.write(Buffer.from(frame.data, 'base64'))
          break
        case 'exit':
          outcome = `${id} ${frame.job.state} · \`claude attach ${id}\` opens it again`
          break
        case 'error':
          outcome = frame.error
          break
        case 'detached':
          break
      }
    })
    socket.on('close', () => {
      restore()
      resolve(outcome)
    })
    socket.on('error', () => {})
    writeFrame(socket, { type: 'attach', id, cols: stdout.columns, rows: stdout.rows })
  })
}

type AgentRow = {
  pid?: number
  id?: string
  cwd: string
  kind: 'interactive' | 'background'
  startedAt: number
  sessionId: string
  name: string
  status?: string
  state?: string
}

export async function listAgentRows(options: { all?: boolean; cwd?: string } = {}): Promise<AgentRow[]> {
  const rows: AgentRow[] = []
  for (const session of await listAllLiveSessions()) {
    if (session.kind === 'bg') continue
    rows.push({
      pid: session.pid,
      cwd: session.cwd,
      kind: 'interactive',
      startedAt: session.startedAt,
      sessionId: session.sessionId,
      name: session.name,
      ...(session.status && { status: session.status }),
    })
  }
  for (const job of await listJobs()) {
    if (!options.all && job.state !== 'running') continue
    rows.push({
      ...(job.pid && { pid: job.pid }),
      id: job.id,
      cwd: job.cwd,
      kind: 'background',
      startedAt: Date.parse(job.createdAt),
      sessionId: job.sessionId,
      name: job.name,
      state: job.state,
    })
  }
  return options.cwd ? rows.filter(row => row.cwd.startsWith(options.cwd!)) : rows
}

export function formatBackgroundSessions(jobs: JobRecord[]): string {
  if (jobs.length === 0) return 'No background sessions. Start one with `claude --bg "<task>"` or /background.'
  const width = Math.max(...jobs.map(job => job.name.length), 4)
  return [
    'Background sessions:',
    ...jobs.map(job => `  ${job.id}  ${job.name.padEnd(width)}  ${job.state}`),
  ].join('\n')
}
