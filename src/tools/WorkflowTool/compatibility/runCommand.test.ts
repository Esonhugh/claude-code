import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCommand } from './runCommand.js'

describe('workflow compatibility command runner', () => {
  it('captures stdout, stderr, exit code, and duration', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'console.log("out"); console.error("err")'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      maxOutputBytes: 10000,
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout.trim(), 'out')
    assert.equal(result.stderr.trim(), 'err')
    assert.equal(result.timedOut, false)
    assert.ok(result.durationMs >= 0)
  })

  it('marks timed out commands and truncates output safely', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => console.log("late"), 2000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
      maxOutputBytes: 10000,
    })

    assert.equal(result.exitCode, null)
    assert.equal(result.timedOut, true)
  })

  it('escalates timed out commands that ignore SIGTERM', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
      ],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
      maxOutputBytes: 10000,
    })

    assert.equal(result.exitCode, null)
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(result.timedOut, true)
  })
})
