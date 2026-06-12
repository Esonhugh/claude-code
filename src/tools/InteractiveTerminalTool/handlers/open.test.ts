import assert from 'node:assert/strict'
import test from 'node:test'

import { PtySessionManager } from '../../../utils/pty/PtySessionManager.ts'
import { FakePtyDriver } from '../../../utils/pty/__fixtures__/FakePtyDriver.ts'
import { handleOpen } from './open.ts'

test('handleOpen returns the resolved default shell when command is omitted', () => {
  const originalShell = process.env.SHELL

  try {
    process.env.SHELL = '/bin/zsh'
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const opened = handleOpen(manager, {
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
