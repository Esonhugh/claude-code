import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { formatDuration } from '../utils/format.js'
import {
  daemonRequest,
  getControlSocketPath,
  getDaemonLogPath,
} from './protocol.js'

const HELP = `Usage: claude daemon [subcommand] [options]

Service lifecycle:
  run               Run the supervisor in the foreground
  status            Show daemon pid, version, uptime
  logs              Tail the daemon log (Ctrl-C to stop)
  stop              Shut down the supervisor and terminate background sessions

  The daemon runs on demand (\`claude --bg\`, \`/background\`) and exits when no
  background session is running and no client is connected.

Options:
  --help, -h        Show this help`

export async function getDaemonStatusText(): Promise<string> {
  let response
  try {
    response = await daemonRequest({ type: 'status' }, 2000)
  } catch {
    return `not running\nsocket: ${getControlSocketPath()}\nlog:    ${getDaemonLogPath()}`
  }
  if (!response.ok || !response.status) return `not running: ${response.error ?? 'no status'}`
  const status = response.status
  return [
    `pid:     ${status.pid}`,
    `version: ${status.version}`,
    `uptime:  ${formatDuration(Date.now() - status.startedAt)}`,
    `origin:  ${status.origin}`,
    `socket:  ${status.socketPath}`,
    `log:     ${getDaemonLogPath()}`,
    '',
    `bg sessions: ${status.running} running, ${status.attached} attached`,
  ].join('\n')
}

export async function stopDaemon(): Promise<string> {
  let running = 0
  try {
    const status = await daemonRequest({ type: 'status' }, 2000)
    if (!status.ok) return 'daemon is not running'
    running = status.status?.running ?? 0
    await daemonRequest({ type: 'shutdown' }, 2000)
  } catch {
    return 'daemon is not running'
  }
  return running > 0
    ? `stopped (terminated ${running} background ${running === 1 ? 'session' : 'sessions'})`
    : 'stopped'
}

export async function daemonMain(args: string[] = []): Promise<void> {
  const sub = args[0] ?? 'status'
  switch (sub) {
    case 'run': {
      const { runSupervisor } = await import('./supervisor.js')
      await runSupervisor()
      return
    }
    case 'status':
      process.stdout.write(`${await getDaemonStatusText()}\n`)
      return
    case 'stop':
      process.stdout.write(`${await stopDaemon()}\n`)
      return
    case 'logs': {
      const log = getDaemonLogPath()
      if (!existsSync(log)) {
        process.stdout.write(`no daemon log at ${log}\n`)
        return
      }
      const tail = spawn('tail', ['-n', '50', '-f', log], { stdio: 'inherit' })
      await new Promise(resolve => tail.on('exit', resolve))
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
