import assert from 'node:assert/strict'
import test from 'node:test'

import { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { FakePtyDriver } from '../../../utils/pty/__fixtures__/FakePtyDriver.js'
import { handleOpen } from './open.js'

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
      args: [],
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
