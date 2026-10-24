import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import type { Socket } from 'net'
import { join } from 'path'
import {
  type AttachFrame,
  connectDaemon,
  daemonRequest,
  ensureDaemon,
  getJobDir,
  hostRequest,
  type JobRecord,
  listJobs,
  readFrames,
  resolveJob,
  stopJob,
  writeFrame,
} from '../daemon/protocol.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { gitExe } from '../utils/git.js'
import { plural } from '../utils/stringUtils.js'
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
  announce?: boolean
}): Promise<JobRecord> {
  await ensureDaemon(options.origin, options.announce)
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
      announce: true,
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

export async function readJobScreen(job: JobRecord): Promise<string | undefined> {
  if (job.state === 'running' && job.ptySock) {
    const response = await hostRequest(job.ptySock, { type: 'screen' }).catch(() => null)
    if (response?.ok) return response.text
  }
  return readFile(join(getJobDir(job.id), 'screen.txt'), 'utf8').catch(() => undefined)
}

export async function logsHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  const text = await readJobScreen(job)
  process.stdout.write(text?.trim() ? `${text.trimEnd()}\n` : `No output recorded for ${job.id}.\n`)
}

export async function stopHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  if (job.state !== 'running') {
    process.stdout.write(`${job.id} is not running (${job.state}).\n`)
    return
  }
  if (!(await stopJob(job))) {
    fail(`couldn't confirm ${job.id} was stopped — the background service may be restarting. Try again in a moment.`)
  }
  process.stdout.write(`stopped ${job.id}\n`)
  if (job.worktree) {
    process.stdout.write(
      `  worktree retained at ${job.worktree.worktreePath}\n  run 'claude rm ${job.id}' to remove worktree and job state\n`,
    )
  }
}

/** Why `rm` left a worktree in place; `discard` is the --discard-unpushed value. */
export type KeptWorktree = { reason: 'uncommitted' | 'unpushed'; detail: string; count: number; discard: string }

export type RemoveResult = { worktreePath?: string; kept?: KeptWorktree }

function worktreeDigest(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12)
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const { code, stdout } = await execFileNoThrowWithCwd(gitExe(), args, { cwd })
  return { code, stdout }
}

/**
 * Deletes a background session: stops it, removes the git worktree it made
 * (unless that would lose uncommitted or unpushed work) and its job state.
 * `discard` names the HEAD a previous refusal reported, to drop that work.
 */
export async function removeJob(job: JobRecord, discard?: string): Promise<RemoveResult> {
  const worktree = job.worktree
  if (worktree && !worktree.hookBased && existsSync(worktree.worktreePath)) {
    const path = worktree.worktreePath
    const head = (await git(path, ['rev-parse', 'HEAD'])).stdout.trim()
    const discardKey = `${head}@${worktreeDigest(path)}`
    const discarding = discard !== undefined && discard === discardKey
    if (!discarding) {
      const status = await git(path, ['status', '--porcelain'])
      if (status.code !== 0 || status.stdout.trim()) {
        return { worktreePath: path, kept: { reason: 'uncommitted', detail: '', count: 0, discard: discardKey } }
      }
      const base = worktree.originalHeadCommit ? [`^${worktree.originalHeadCommit}`] : []
      const unpushed = await git(path, ['log', '--format=%h %s', 'HEAD', ...base, '--not', '--remotes'])
      const commits = unpushed.stdout.trim().split('\n').filter(Boolean)
      if (commits.length > 0) {
        const count = commits.length
        const more = count > 1 ? ` and ${count - 1} more` : ''
        return {
          worktreePath: path,
          kept: {
            reason: 'unpushed',
            detail: `${count} unpushed ${plural(count, 'commit')} on ${worktree.worktreeBranch ?? 'detached HEAD'}: ${commits[0]}${more}`,
            count,
            discard: discardKey,
          },
        }
      }
    }
    if (job.state === 'running') await stopJob(job)
    await git(worktree.originalCwd, ['worktree', 'remove', '--force', path])
    if (worktree.worktreeBranch) await git(worktree.originalCwd, ['branch', '-D', worktree.worktreeBranch])
  } else if (job.state === 'running') {
    await stopJob(job)
  }
  await rm(getJobDir(job.id), { recursive: true, force: true })
  return worktree ? { worktreePath: worktree.worktreePath } : {}
}

/** The `kept <id>` explanation lines, shared with the agent view. */
export function keptWorktreeLines(result: KeptWorktree, id: string): string[] {
  const again = `run 'claude rm ${id}' again`
  if (result.reason === 'uncommitted') {
    return [
      'The worktree has uncommitted changes. Deleting it would lose them.',
      `commit or stash them and ${again}, or delete the session from 'claude agents' (ctrl+x twice) to discard them`,
    ]
  }
  const them = result.count === 1 ? 'it' : 'them'
  return [
    `${result.detail}. ${result.count === 1 ? 'It exists' : 'They exist'} on no remote, so deleting the worktree would lose ${them}.`,
    `push ${them} and ${again}, or discard the worktree and its commits: claude rm ${id} --discard-unpushed ${result.discard}`,
  ]
}

export async function rmHandler(query?: string, options: { discardUnpushed?: string } = {}): Promise<void> {
  const job = await findJob(query)
  const result = await removeJob(job, options.discardUnpushed?.toLowerCase())
  if (result.kept) {
    process.stdout.write(
      `kept ${job.id} — its worktree is still at “${result.worktreePath}”\n` +
        keptWorktreeLines(result.kept, job.id).map(line => `  ${line}\n`).join(''),
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`removed ${job.id}${result.worktreePath ? `\n  worktree: “${result.worktreePath}”` : ''}\n`)
}

export async function respawnJob(job: JobRecord, origin: string): Promise<JobRecord> {
  await ensureDaemon(origin)
  const response = await daemonRequest({ type: 'respawn', id: job.id, env: childEnv() })
  if (!response.ok) throw new Error(response.error ?? 'The background service refused the request.')
  return response.job!
}

export async function respawnHandler(query?: string): Promise<void> {
  const job = await findJob(query)
  try {
    await respawnJob(job, 'started by `claude respawn`')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  process.stdout.write(`respawned ${job.id}\n`)
}

export async function attachHandler(query?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("'claude attach' requires an interactive terminal.")
  }
  let job = await findJob(query)
  if (job.state !== 'running') {
    // A stopped session keeps its conversation: attaching resumes it.
    try {
      job = await respawnJob(job, 'started by `claude attach`')
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  const result = await attachToJob(job)
  process.stdout.write(`${result}\n`)
}

/** Proxies this terminal to the worker's PTY until detach or exit. */
export async function attachToJob(job: JobRecord): Promise<string> {
  const id = job.id
  if (!job.ptySock) return `${id} is not running`
  let socket: Socket
  try {
    socket = await connectDaemon(1000, job.ptySock)
  } catch {
    return `${id} is not running`
  }
  const stdin = process.stdin
  const stdout = process.stdout
  let modes = ''
  const restore = () => {
    stdin.setRawMode?.(false)
    stdin.pause()
    stdin.removeListener('data', onInput)
    stdout.removeListener('resize', onResize)
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
          // SIGWINCH does not exist on Windows; 'resize' fires everywhere.
          stdout.on('resize', onResize)
          break
        case 'output':
          stdout.write(Buffer.from(frame.data, 'base64'))
          break
        case 'exit':
          outcome = `${id} ${frame.state} · \`claude attach ${id}\` opens it again`
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
    writeFrame(socket, { type: 'attach', cols: stdout.columns, rows: stdout.rows })
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
  const live = await listAllLiveSessions()
  for (const session of live) {
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
    const status = job.state === 'running' ? live.find(session => session.sessionId === job.sessionId)?.status : undefined
    rows.push({
      ...(job.pid && { pid: job.pid }),
      id: job.id,
      cwd: job.worktree?.worktreePath ?? job.cwd,
      kind: 'background',
      startedAt: Date.parse(job.createdAt),
      sessionId: job.sessionId,
      name: job.name,
      ...(status && { status }),
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
