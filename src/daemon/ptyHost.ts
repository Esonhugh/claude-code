import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type Socket } from 'net'
import { join } from 'path'
import {
  applyTerminalOutput,
  createTerminalScreenRenderer,
  renderedPreview,
  resizeTerminalScreenRenderer,
  type TerminalScreenRenderer,
} from '../utils/pty/terminalScreenRenderer.js'
import {
  type AttachClientFrame,
  type JobRecord,
  type PtyHostRequest,
  readFrames,
  writeFrame,
} from './protocol.js'

const STOP_GRACE_MS = 5000

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

/** Updates the job state directly: the supervisor may be gone. */
function patchJob(jobDir: string | undefined, patch: Partial<JobRecord>): void {
  if (!jobDir) return
  try {
    const path = join(jobDir, 'state.json')
    const job = { ...(JSON.parse(readFileSync(path, 'utf8')) as JobRecord), ...patch, updatedAt: new Date().toISOString() }
    writeFileSync(path, JSON.stringify(job, null, 2), { mode: 0o600 })
  } catch {
    // The job was removed.
  }
}

/**
 * `claude --bg-pty-host <sock> <cols> <rows> -- <cmd> [args...]`
 *
 * Owns one background worker's PTY in its own detached process, so the
 * worker outlives the supervisor (`claude daemon stop --keep-workers`) and
 * a later supervisor can adopt it again through <sock>.
 */
export async function runPtyHost(argv: string[]): Promise<void> {
  const dashes = argv.indexOf('--')
  if (dashes < 3 || dashes === argv.length - 1) {
    process.stderr.write('bad argv: --bg-pty-host <sock> <cols> <rows> -- <file> [args...]\n')
    process.exit(2)
  }
  const sockPath = argv[0]!
  let cols = Number(argv[1]) || 120
  let rows = Number(argv[2]) || 40
  const command = argv.slice(dashes + 1)
  const jobDir = process.env.CLAUDE_JOB_DIR
  process.title = 'claude bg-pty-host'
  process.on('SIGHUP', () => {})

  const screen = createTerminalScreenRenderer(cols, rows)
  const clients = new Set<Socket>()
  const watchers = new Set<Socket>()
  const stopWaiters = new Set<Socket>()
  let stopping = false
  let exited = false

  const proc = Bun.spawn(command, {
    env: { ...process.env, CLAUDE_PTY_SOCK: sockPath },
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        applyTerminalOutput(screen, Buffer.from(data).toString('utf8'))
        const encoded = Buffer.from(data).toString('base64')
        for (const client of clients) writeFrame(client, { type: 'output', data: encoded })
      },
    },
  })
  const terminal = proc.terminal!

  const resize = (c: number, r: number) => {
    cols = c
    rows = r
    terminal.resize(c, r)
    resizeTerminalScreenRenderer(screen, c, r)
  }

  const stop = () => {
    if (stopping) return
    stopping = true
    proc.kill('SIGTERM')
    // A worker suspended by a stray ^Z would never see the SIGTERM.
    if (process.platform !== 'win32') proc.kill('SIGCONT')
    setTimeout(() => proc.kill('SIGKILL'), STOP_GRACE_MS).unref()
  }

  const attach = (socket: Socket, c: number, r: number) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    writeFrame(socket, { type: 'attached', modes: terminalModes(screen) })
    // A resize makes the fullscreen renderer repaint everything.
    if (c === cols && r === rows) {
      resize(c, Math.max(2, r - 1))
      setTimeout(() => resize(c, r), 50)
    } else if (c > 0 && r > 0) {
      resize(c, r)
    }
    readFrames(socket, raw => {
      const frame = raw as AttachClientFrame
      if (frame.type === 'input') terminal.write(Buffer.from(frame.data, 'base64'))
      else if (frame.type === 'resize' && frame.cols > 0 && frame.rows > 0) resize(frame.cols, frame.rows)
    })
  }

  const server = createServer(socket => {
    socket.on('error', () => {})
    let first = true
    readFrames(socket, raw => {
      if (!first) return
      first = false
      const request = raw as PtyHostRequest
      switch (request.type) {
        case 'attach':
          attach(socket, request.cols, request.rows)
          return
        case 'watch':
          watchers.add(socket)
          socket.on('close', () => watchers.delete(socket))
          return
        case 'screen':
          writeFrame(socket, { ok: true, text: renderedPreview(screen) })
          socket.end()
          return
        case 'status':
          writeFrame(socket, { ok: true, pid: proc.pid, attached: clients.size })
          socket.end()
          return
        case 'input':
          terminal.write(Buffer.from(request.data, 'base64'))
          writeFrame(socket, { ok: true })
          socket.end()
          return
        case 'detach':
          for (const client of clients) {
            writeFrame(client, { type: 'detached' })
            client.end()
          }
          writeFrame(socket, { ok: true })
          socket.end()
          return
        case 'stop':
          stopWaiters.add(socket)
          stop()
          return
      }
    })
  })

  void proc.exited.then(code => {
    exited = true
    try {
      writeFileSync(join(jobDir ?? '.', 'screen.txt'), `${renderedPreview(screen)}\n`, { mode: 0o600 })
    } catch {
      // Best effort: logs falls back to "no output recorded".
    }
    const state = stopping ? 'stopped' : 'exited'
    patchJob(jobDir, { state, exitCode: code, pid: undefined, hostPid: undefined })
    for (const socket of [...clients, ...watchers]) {
      writeFrame(socket, { type: 'exit', state })
      socket.end()
    }
    for (const waiter of stopWaiters) {
      writeFrame(waiter, { ok: true })
      waiter.end()
    }
    server.close()
    try {
      unlinkSync(sockPath)
    } catch {
      // Already gone.
    }
    setTimeout(() => process.exit(0), 100)
  })

  process.on('SIGTERM', () => (exited ? process.exit(0) : stop()))

  try {
    unlinkSync(sockPath)
  } catch {
    // No stale socket.
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      // Named pipes on Windows have no mode bits.
      if (process.platform !== 'win32') chmodSync(sockPath, 0o600)
      resolve()
    })
  })
  patchJob(jobDir, { pid: proc.pid })
  await new Promise(() => {})
}
