import { spawn } from 'node:child_process'

export type RunCommandInput = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}

export type RunCommandResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function appendLimited(current: string, chunk: Buffer, maxOutputBytes: number): string {
  const combined = current + chunk.toString('utf8')
  if (Buffer.byteLength(combined, 'utf8') <= maxOutputBytes) return combined
  return `${combined.slice(0, maxOutputBytes)}\n[truncated]\n`
}

export async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const startedAt = Date.now()

  return await new Promise(resolve => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
      }, 250)
    }, input.timeoutMs)

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, chunk, input.maxOutputBytes)
    })

    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, chunk, input.maxOutputBytes)
    })

    child.on('error', error => {
      clearTimeout(timeout)
      resolve({
        exitCode: timedOut ? null : 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}${error.message}\n`,
        timedOut,
      })
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout)
      resolve({
        exitCode: timedOut ? null : exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}
