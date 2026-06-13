import assert from 'node:assert/strict'
import test from 'node:test'

import { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { FakePtyDriver } from '../../../utils/pty/__fixtures__/FakePtyDriver.js'
import { handleOpen } from './open.js'

class CaptureDriver extends FakePtyDriver {
  lastOpenOptions: Record<string, unknown> | undefined

  override open(options: Record<string, unknown>) {
    this.lastOpenOptions = options
    return super.open(options as never)
  }
}

test('handleOpen returns the resolved default shell when command is omitted', async () => {
  const originalShell = process.env.SHELL

  try {
    process.env.SHELL = '/bin/zsh'
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const opened = await handleOpen(manager, {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })

    assert.equal((opened as { command?: string }).command, '/bin/zsh')
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  }
})

test('handleOpen returns the provided command', async () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })

  const opened = await handleOpen(manager, {
    action: 'open',
    command: '/bin/bash',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.equal((opened as { command?: string }).command, '/bin/bash')
})

test('handleOpen forwards explicit args to the PTY manager', async () => {
  const driver = new CaptureDriver()
  const manager = new PtySessionManager({ driver })

  await handleOpen(manager, {
    action: 'open',
    command: 'bash',
    args: ['--noprofile', '--norc'],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.deepEqual(driver.lastOpenOptions?.args, ['--noprofile', '--norc'])
  assert.equal(driver.lastOpenOptions?.command, 'bash')
})
