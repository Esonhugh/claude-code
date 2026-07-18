import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  resolveDefaultShell,
  resolveTerminalCommand,
} from '../shell/resolveDefaultShell.js'
import { createBunPtyDriver } from './bunPtyDriver.js'
import { PtySessionManager } from './PtySessionManager.js'
import { DEFAULT_MAX_BUFFERED_CHUNKS } from './types.js'

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('Bun PTY driver starts the resolved terminal shell and emits output', async () => {
  const driver = createBunPtyDriver()
  const resolved = resolveTerminalCommand()
  const shell = resolved.command
  const sessionId = 'term_test'

  assert.equal(shell, resolved.command)

  driver.open({
    command: shell,
    args: resolved.args,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    sessionId,
  })

  let output = ''
  driver.write(
    sessionId,
    shell.endsWith('pwsh') || shell === 'powershell'
      ? 'Write-Output PTY_OK\r'
      : 'echo PTY_OK\r',
  )

  await waitFor(() => {
    const chunk = driver.write(sessionId, '')
    if (chunk?.text) {
      output += chunk.text
    }
    return /PTY_OK/.test(output)
  })

  assert.match(output, /PTY_OK/)

  const closed = driver.close(sessionId)
  assert.equal(closed.state, 'closed')
})

test('falls back from invalid SHELL to configured/default shell command', () => {
  const originalShell = process.env.SHELL

  try {
    process.env.SHELL = '/definitely/missing-shell'
    const fallback = resolveDefaultShell() === 'powershell' ? 'powershell' : 'bash'
    assert.match(resolveTerminalCommand().command, new RegExp(`${fallback}$`))
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  }
})

test('Bun PTY driver starts an explicit bash command with explicit args', async () => {
  const driver = createBunPtyDriver()
  const sessionId = 'term_explicit_bash'
  const tempDir = mkdtempSync(join(tmpdir(), 'bun-pty-driver-bash-'))
  const bashEnvPath = join(tempDir, '.bashrc')

  writeFileSync(bashEnvPath, 'export PS1="FROM_BASHRC> "\n')

  try {
    driver.open({
      command: 'bash',
      args: ['--noprofile', '--norc'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      sessionId,
      env: {
        HOME: tempDir,
      },
    })

    let output = ''
    driver.write(sessionId, 'echo PTY_EXPLICIT_OK\r')

    await waitFor(() => {
      const chunk = driver.write(sessionId, '')
      if (chunk?.text) {
        output += chunk.text
      }
      return output.includes('PTY_EXPLICIT_OK')
    })

    assert.match(output, /PTY_EXPLICIT_OK/)
    assert.doesNotMatch(output, /FROM_BASHRC>/)

    const closed = driver.close(sessionId)
    assert.equal(closed.state, 'closed')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Bun PTY driver throws when the resolved executable is missing', () => {
  const driver = createBunPtyDriver()

  assert.throws(
    () => {
      driver.open({
        command: 'definitely-not-found-bin',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        sessionId: 'term_missing_bin',
      })
    },
    /Executable not found in \$PATH: "definitely-not-found-bin"/,
  )
})

test('supports a real interrupt flow against a live PTY shell', async () => {
  const driver = createBunPtyDriver()
  const manager = new PtySessionManager({
    driver,
    maxBufferedChunks: 64,
    exitedSessionTtlMs: 60_000,
  })

  const resolved = resolveTerminalCommand()
  const opened = manager.open({
    command: resolved.command,
    args: resolved.args,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  manager.write(opened.sessionId, 'sleep 5\r')
  const signaled = manager.signal(opened.sessionId, 'SIGINT')

  assert.equal(signaled.state, 'closed')
  assert.equal(signaled.exitCode, 130)
  assert.equal(signaled.signal, 'SIGINT')
  assert.equal(manager.status(opened.sessionId).state, 'closed')
})

test('Bun PTY driver keeps naturally exited sessions readable until explicit disposal', async () => {
  const driver = createBunPtyDriver()
  const manager = new PtySessionManager({
    driver,
    maxBufferedChunks: 64,
    exitedSessionTtlMs: 60_000,
  })

  const opened = manager.open({
    command: '/bin/sh',
    args: ['-c', 'printf TERMINAL_L5_OK; sleep 0.1'],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  await waitFor(() => manager.status(opened.sessionId).state === 'closed')

  assert.equal(manager.status(opened.sessionId).state, 'closed')
  assert.equal(manager.status(opened.sessionId).exitCode, 0)
  assert.equal(
    manager.read(opened.sessionId, 0).chunks.map(chunk => chunk.text).join(''),
    'TERMINAL_L5_OK',
  )
  assert.equal(
    manager.list().find(session => session.sessionId === opened.sessionId)?.state,
    'closed',
  )

  manager.reapExpiredSessions(Date.now() + 60_001)
  assert.throws(() => manager.status(opened.sessionId), /Unknown PTY session/)
})

test('Bun PTY driver bounds queued output and clears runtime session on close', async () => {
  const driver = createBunPtyDriver()
  const resolved = resolveTerminalCommand()
  const sessionId = 'term_queue_bound'
  driver.open({
    command: resolved.command,
    args: resolved.args,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    sessionId,
  })

  driver.write(
    sessionId,
    `for i in {1..${DEFAULT_MAX_BUFFERED_CHUNKS + 50}}; do echo QUEUE_$i; done\r`,
  )

  let chunks = 0
  await waitFor(() => {
    let chunk = driver.write(sessionId, '')
    while (chunk) {
      chunks += 1
      chunk = driver.write(sessionId, '')
    }
    return chunks > 0
  })

  assert.ok(chunks <= DEFAULT_MAX_BUFFERED_CHUNKS)

  const closed = driver.close(sessionId)
  assert.equal(closed.state, 'closed')
  assert.throws(() => driver.status(sessionId), /Unknown PTY session/)
})
