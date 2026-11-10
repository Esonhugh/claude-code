// Runs gracefulShutdown and records every sleep() it takes, optionally with a
// live shell command, so the parent can check the 250ms transcript grace.
import { mock } from 'bun:test'
import { spawn } from 'child_process'
import { appendFileSync } from 'fs'

const [, , logPath, withShell] = process.argv
const sleepPath = new URL('./sleep.ts', import.meta.url).pathname
const real = await import(sleepPath)
const realSleep = real.sleep
mock.module(sleepPath, () => ({
  ...real,
  sleep: (ms: number, ...rest: unknown[]) => {
    appendFileSync(logPath!, `${ms}\n`)
    return realSleep(ms, ...rest)
  },
}))
if (withShell === 'shell') {
  const { wrapSpawn } = await import('./ShellCommand.js')
  const { TaskOutput } = await import('./task/TaskOutput.js')
  const child = spawn('bash', ['-c', 'sleep 600'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const cmd = wrapSpawn(child, new AbortController().signal, 600_000, new TaskOutput('shell-grace', null))
  const { registerCleanup } = await import('./cleanupRegistry.js')
  registerCleanup(async () => cmd.kill())
}
const { gracefulShutdown } = await import('./gracefulShutdown.js')
await gracefulShutdown(0)
