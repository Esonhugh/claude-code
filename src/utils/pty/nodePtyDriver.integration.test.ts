import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveDefaultShell,
  resolveInteractiveTerminalCommand,
} from '../shell/resolveDefaultShell.ts'
import { createNodePtyDriver } from './nodePtyDriver.ts'
import { PtySessionManager } from './PtySessionManager.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('node-pty driver starts the resolved interactive terminal shell and emits output', async () => {
  const driver = createNodePtyDriver()
  const shell = resolveInteractiveTerminalCommand()
  const sessionId = 'term_test'

  assert.equal(driver.resolveDefaultCommand(), shell)

  driver.open({
    command: shell,
    args: shell.endsWith('pwsh') || shell === 'powershell' ? ['-NoLogo'] : [],
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
    assert.equal(resolveInteractiveTerminalCommand(), fallback)
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  }
})

test('supports a real interrupt flow against a live PTY shell', async () => {
  const driver = createNodePtyDriver()
  const manager = new PtySessionManager({
    driver,
    maxBufferedChunks: 64,
    exitedSessionTtlMs: 60_000,
  })

  const opened = manager.open({
    command: resolveInteractiveTerminalCommand(),
    args: [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  manager.write(opened.sessionId, 'sleep 5\r')
  const signaled = manager.signal(opened.sessionId, 'SIGINT')

  assert.equal(typeof signaled.state, 'string')

  const closed = manager.close(opened.sessionId, false)
  assert.equal(closed.state, 'closed')
})
