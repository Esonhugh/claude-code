import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import {
  type DaemonStatus,
  daemonRequest,
  getControlSocketPath,
  getDaemonLogPath,
  getSockDir,
  listJobs,
  redactPipeNonce,
  stopJob,
} from './protocol.js'

const HELP = `Usage: claude daemon [subcommand] [options]

Service lifecycle:
  run               Run the supervisor in the foreground
  status            Show daemon pid, version, uptime
  logs              Tail the daemon log (Ctrl-C to stop)
  stop              Shut down the supervisor and terminate background sessions
    --any           stop an on-demand daemon (there is no installed service)
    --keep-workers  leave detached sessions running

  The daemon runs on demand (\`claude --bg\`, \`/background\`) and exits when no
  background session is running and no client is connected.

Options:
  --help, -h        Show this help`

function daemonLogLine(): string {
  const log = getDaemonLogPath()
  try {
    return `  daemon.log:   ${statSync(log).size}B at ${log}`
  } catch {
    return '  daemon.log:   absent'
  }
}

export async function getDaemonStatusText(): Promise<string> {
  const socketPath = getControlSocketPath()
  const sockDir = process.platform === 'win32' ? '\\\\.\\pipe\\cc-daemon-*' : getSockDir()
  let response
  try {
    response = await daemonRequest({ type: 'status' }, 2000)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'failed'
    const recorded = (await listJobs()).filter(job => job.state === 'running').length
    return [
      'not running',
      '',
      'bg sessions:',
      `  sock dir:     ${sockDir}`,
      `  control.sock: unreachable (connect ${code} ${redactPipeNonce(socketPath)})`,
      `  bg workers:   ${recorded} recorded running (control unreachable)`,
      daemonLogLine(),
    ].join('\n')
  }
  if (!response.ok || !response.status) return `not running: ${response.error ?? 'no status'}`
  const status = response.status
  const lines = [
    `pid:     ${status.pid}`,
    `version: ${status.version}`,
    `uptime:  ${Math.floor((Date.now() - status.startedAt) / 1000)}s`,
    `origin:  ${status.origin}`,
    `log:     ${getDaemonLogPath()}`,
    '',
    'bg sessions:',
    `  sock dir:     ${sockDir}`,
    '  control.sock: reachable',
    `  bg workers:   ${status.running} running (control.sock)`,
    daemonLogLine(),
  ]
  if (status.running > 0) {
    lines.push(
      '',
      'holding this daemon open:',
      `  ${status.running} bg ${status.running === 1 ? 'worker' : 'workers'} running (daemon waits for them to settle)`,
      '',
      'to let it idle-exit: wait for (or cancel) bg workers and close any `claude agents`',
    )
  }
  return lines.join('\n')
}

function originKind(origin: string): string {
  return origin.split(' ')[0] || 'unknown'
}

/** Ends the background sessions recorded as running whose PTY hosts still answer. */
async function reapRecordedWorkers(): Promise<number> {
  const running = (await listJobs()).filter(job => job.state === 'running')
  const stopped = await Promise.all(running.map(stopJob))
  return stopped.filter(Boolean).length
}

/**
 * `claude daemon stop [--keep-workers]`. The daemon here only ever runs on
 * demand (no launchd/systemd unit), so, like official, plain `stop` asks for
 * `--any` before stopping it; the /daemon panel passes any: true.
 */
export async function stopDaemon(options: { keepWorkers?: boolean; any?: boolean } = {}): Promise<{ lines: string[]; ok: boolean }> {
  const keep = options.keepWorkers === true
  const summary = (n: number) =>
    keep || n === 0 ? 'stopped' : `stopped (terminated ${n} background ${n === 1 ? 'session' : 'sessions'})`
  let status: DaemonStatus | undefined
  try {
    const response = await daemonRequest({ type: 'status' }, 2000)
    if (response.ok) status = response.status
  } catch {
    // Not running.
  }
  if (status && !options.any) {
    return {
      ok: false,
      lines: [
        `no background service is installed, but a daemon is running (pid=${status.pid}, origin=${originKind(status.origin)}). Run \`claude daemon stop --any\` to stop it.`,
      ],
    }
  }
  if (status) {
    const reaped = keep ? 0 : status.running
    try {
      await daemonRequest({ type: 'shutdown', reapWorkers: !keep }, 30_000)
    } catch {
      // It exits right after answering.
    }
    return { ok: true, lines: [summary(reaped), 'note: the next `claude agents` or `claude --bg` will start a new one'] }
  }
  const reaped = keep ? 0 : await reapRecordedWorkers()
  return { ok: true, lines: [reaped === 0 ? 'no daemon running' : summary(reaped)] }
}

export async function daemonMain(args: string[] = []): Promise<void> {
  const sub = args[0] ?? 'status'
  switch (sub) {
    case 'run': {
      const { runSupervisor } = await import('./supervisor.js')
      await runSupervisor()
      return
    }
    case 'status': {
      const text = await getDaemonStatusText()
      process.stdout.write(`${text}\n`)
      if (text.startsWith('not running')) process.exitCode = 1
      return
    }
    case 'stop': {
      const unknown = args.slice(1).find(arg => arg !== '--keep-workers' && arg !== '--any')
      if (unknown) {
        process.stderr.write(`Unknown option "${unknown}" for \`claude daemon stop\`.\n`)
        process.exitCode = 1
        return
      }
      const result = await stopDaemon({ keepWorkers: args.includes('--keep-workers'), any: args.includes('--any') })
      ;(result.ok ? process.stdout : process.stderr).write(`${result.lines.join('\n')}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }
    case 'logs': {
      const log = getDaemonLogPath()
      if (!existsSync(log)) {
        process.stdout.write(`no daemon log at ${log}\n`)
        return
      }
      const tail = spawn('tail', ['-n', '50', '-f', log], { stdio: 'inherit' })
      await new Promise<void>(resolve => {
        tail.on('exit', code => {
          if (code) process.exitCode = code
          resolve()
        })
        // No tail on stock Windows.
        tail.on('error', error => {
          process.stderr.write(`tail failed: ${error.message}\n`)
          process.exitCode = 1
          resolve()
        })
      })
      return
    }
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(`${HELP}\n`)
      return
    default:
      process.stderr.write(`Unknown daemon subcommand "${sub}".\n\n${HELP}\n`)
      process.exitCode = 1
  }
}
