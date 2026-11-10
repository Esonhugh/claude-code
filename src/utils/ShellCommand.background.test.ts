import { expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'

test.skipIf(process.platform === 'win32')(
  'a piped command backgrounded with skipSpill keeps its full stdout in memory',
  async () => {
    const child = spawn('bash', ['-c', 'echo first; sleep 0.2; echo second'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = new TaskOutput('background-skip-spill', null)
    const cmd = wrapSpawn(child, new AbortController().signal, 60_000, output)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(cmd.background('async_hook_test', { skipSpill: true })).toBe(true)
    await cmd.result
    await new Promise(resolve => setImmediate(resolve))
    expect(await output.getStdout()).toBe('first\nsecond\n')
    cmd.cleanup()
  },
)
