import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TerminalSpecialKey } from './types.js'

import { FakePtyDriver } from './__fixtures__/FakePtyDriver.js'
import { PtySessionManager } from './PtySessionManager.js'
import {
  INITIAL_TERMINAL_SIZE,
  SESSION_STATES,
} from './types.js'
import { keyToSequence } from './keyMap.js'

describe('pty shared types and key map', () => {
  it('exposes the session states and initial size constants', () => {
    assert.deepEqual(SESSION_STATES, ['starting', 'running', 'exited', 'closed', 'failed'])
    assert.deepEqual(INITIAL_TERMINAL_SIZE, { cols: 120, rows: 30 })
  })

  it('maps supported keys to terminal sequences', () => {
    assert.equal(keyToSequence('CTRL_C'), '')
    assert.equal(keyToSequence('ENTER'), '\r')
  })

  it('throws for unsupported keys', () => {
    assert.throws(
      () => keyToSequence('CTRL_Z' as TerminalSpecialKey),
      /Unsupported terminal key: CTRL_Z/,
    )
  })
})

describe('PtySessionManager', () => {
  it('opens a running session with defaults and an empty readable buffer', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const session = manager.open({ cwd: '/tmp/project' })

    assert.equal(session.sessionId, 'session-1')
    assert.equal(session.state, 'running')
    assert.equal(session.cwd, '/tmp/project')
    assert.equal(session.cols, INITIAL_TERMINAL_SIZE.cols)
    assert.equal(session.rows, INITIAL_TERMINAL_SIZE.rows)
    assert.equal(session.lowestAvailableCursor, 0)
    assert.equal(session.nextCursor, 0)
    assert.equal(session.truncatedBeforeCursor, false)

    assert.deepEqual(manager.read(session.sessionId, 0), {
      chunks: [],
      lowestAvailableCursor: 0,
      nextCursor: 0,
      truncatedBeforeCursor: false,
    })
  })

  it('writes data and reads appended output from the requested cursor', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const session = manager.open({ cwd: '/tmp/project' })

    manager.write(session.sessionId, 'pwd\n')

    const firstRead = manager.read(session.sessionId, 0)
    assert.equal(firstRead.lowestAvailableCursor, 0)
    assert.equal(firstRead.nextCursor, Buffer.byteLength('pwd\n', 'utf8'))
    assert.equal(firstRead.truncatedBeforeCursor, false)
    assert.equal(firstRead.chunks.length, 1)
    assert.equal(firstRead.chunks[0]?.start, 0)
    assert.equal(firstRead.chunks[0]?.end, Buffer.byteLength('pwd\n', 'utf8'))
    assert.equal(firstRead.chunks[0]?.text, 'pwd\n')
    assert.equal(firstRead.chunks[0]?.stream, 'stdout')

    assert.deepEqual(manager.read(session.sessionId, firstRead.nextCursor), {
      chunks: [],
      lowestAvailableCursor: 0,
      nextCursor: Buffer.byteLength('pwd\n', 'utf8'),
      truncatedBeforeCursor: false,
    })
  })

  it('reports status and closes an existing session', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const session = manager.open({ cwd: '/tmp/project' })
    manager.write(session.sessionId, 'exit\n')

    const runningStatus = manager.status(session.sessionId)
    assert.equal(runningStatus.state, 'running')
    assert.equal(runningStatus.lowestAvailableCursor, 0)
    assert.equal(runningStatus.nextCursor, Buffer.byteLength('exit\n', 'utf8'))

    const closedStatus = manager.close(session.sessionId)
    assert.equal(closedStatus.state, 'closed')
    assert.equal(closedStatus.exitCode, 0)
    assert.equal(typeof closedStatus.exitedAt, 'number')

    assert.equal(manager.status(session.sessionId).state, 'closed')
  })

  it('updates cols and rows when resizing a session', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const session = manager.open({ cwd: '/tmp/project' })
    const resized = manager.resize(session.sessionId, 140, 40)

    assert.equal(resized.cols, 140)
    assert.equal(resized.rows, 40)
  })

  it('supports sending SIGINT to an open session', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const session = manager.open({ cwd: '/tmp/project' })
    const signaled = manager.signal(session.sessionId, 'SIGINT')

    assert.equal(signaled.state, 'running')
    assert.equal(signaled.nextCursor, Buffer.byteLength('', 'utf8'))
  })

  it('trims buffered chunks and marks reads before the lowest available cursor as truncated', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
      maxBufferedChunks: 2,
    })

    const session = manager.open({ cwd: '/tmp/project' })

    const one = Buffer.byteLength('one\n', 'utf8')
    const two = Buffer.byteLength('two\n', 'utf8')
    const three = Buffer.byteLength('three\n', 'utf8')

    manager.write(session.sessionId, 'one\n')
    manager.write(session.sessionId, 'two\n')
    manager.write(session.sessionId, 'three\n')

    const readFromStart = manager.read(session.sessionId, 0)
    assert.equal(readFromStart.lowestAvailableCursor, one)
    assert.equal(readFromStart.nextCursor, one + two + three)
    assert.equal(readFromStart.truncatedBeforeCursor, true)
    assert.deepEqual(
      readFromStart.chunks.map(chunk => ({ start: chunk.start, end: chunk.end, text: chunk.text })),
      [
        { start: one, end: one + two, text: 'two\n' },
        { start: one + two, end: one + two + three, text: 'three\n' },
      ],
    )

    const sessionStatus = manager.status(session.sessionId)
    assert.equal(sessionStatus.lowestAvailableCursor, one)
    assert.equal(sessionStatus.nextCursor, one + two + three)
    assert.equal(sessionStatus.truncatedBeforeCursor, true)

    const readFromLowestCursor = manager.read(session.sessionId, one)
    assert.equal(readFromLowestCursor.truncatedBeforeCursor, false)
    assert.equal(readFromLowestCursor.chunks.length, 2)
  })

  it('keeps raw chunks for read while exposing a rendered preview for large terminal redraws', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })
    const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

    manager.write(session.sessionId, 'Claude is thinking... 12%')
    manager.write(session.sessionId, '\rClaude is thinking... 100%')

    const raw = manager.read(session.sessionId, 0)
    const preview = manager.getRenderedPreview(session.sessionId)

    assert.equal(
      raw.chunks.map(chunk => chunk.text).join(''),
      'Claude is thinking... 12%\rClaude is thinking... 100%',
    )
    assert.equal(preview.includes('Claude is thinking... 100%'), true)
  })

  it('keeps the final rendered preview after close', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })
    const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

    manager.write(session.sessionId, 'Claude complete')
    manager.close(session.sessionId)

    assert.equal(manager.getRenderedPreview(session.sessionId).includes('Claude complete'), true)
  })

  it('reaps closed sessions after the configured TTL', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
      exitedSessionTtlMs: 100,
    })

    const session = manager.open({ cwd: '/tmp/project' })
    manager.close(session.sessionId)
    manager.reapExpiredSessions(Date.now() + 101)

    assert.throws(() => manager.status(session.sessionId), /Unknown PTY session/)
  })
})
