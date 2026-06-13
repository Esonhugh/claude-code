import assert from 'node:assert/strict'
import test from 'node:test'

import { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { FakePtyDriver } from '../../../utils/pty/__fixtures__/FakePtyDriver.js'
import { handleRead } from './read.js'

test('handleRead returns a screen snapshot and ignores the requested cursor', () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })
  const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

  manager.write(session.sessionId, 'alpha\nbeta\n')

  const result = handleRead(manager, {
    action: 'read',
    cursor: 999,
    maxBytes: 4096,
    sessionId: session.sessionId,
  })

  assert.equal(result.fromCursor, 0)
  assert.equal(result.toCursor, Buffer.byteLength('alpha\nbeta', 'utf8'))
  assert.equal(result.text, 'alpha\nbeta')
  assert.equal(result.truncatedBeforeCursor, false)
})
