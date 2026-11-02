import { expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { waitForLiveShellResults, wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'

test.skipIf(process.platform === 'win32')(
  'waitForLiveShellResults settles once a killed command has reported its result',
  async () => {
    const child = spawn('bash', ['-c', 'sleep 600'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const cmd = wrapSpawn(child, new AbortController().signal, 600_000, new TaskOutput('live-results', null))
    let settled = false
    const waiting = waitForLiveShellResults().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    cmd.kill()
    await waiting
    expect((await cmd.result).code).toBe(137)
    await waitForLiveShellResults()
  },
)
