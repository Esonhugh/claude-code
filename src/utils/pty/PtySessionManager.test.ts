import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TerminalSpecialKey } from './types.js'

import { FakePtyDriver } from './__fixtures__/FakePtyDriver.js'
import { PtySessionManager } from './PtySessionManager.js'
import {
  DEFAULT_MAX_BUFFERED_CHUNKS,
  INITIAL_TERMINAL_SIZE,
  MAX_TERMINAL_SIZE,
  SESSION_STATES,
} from './types.js'
import { keyToSequence } from './keyMap.js'

describe('pty shared types and key map', () => {
  it('exposes the session states and initial size constants', () => {
    assert.deepEqual(SESSION_STATES, ['starting', 'running', 'exited', 'closed', 'failed'])
    assert.deepEqual(INITIAL_TERMINAL_SIZE, { cols: 120, rows: 30 })
    assert.deepEqual(MAX_TERMINAL_SIZE, { cols: 1000, rows: 1000 })
    assert.equal(DEFAULT_MAX_BUFFERED_CHUNKS, 200)
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

    assert.equal(session.sessionId, 'term-1')
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

  it('writes data and reads the current screen snapshot regardless of cursor', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const session = manager.open({ cwd: '/tmp/project' })

    manager.write(session.sessionId, 'pwd\n')

    const firstRead = manager.read(session.sessionId, 0)
    assert.equal(firstRead.lowestAvailableCursor, 0)
    assert.equal(firstRead.nextCursor, Buffer.byteLength('pwd', 'utf8'))
    assert.equal(firstRead.truncatedBeforeCursor, false)
    assert.equal(firstRead.chunks.length, 1)
    assert.equal(firstRead.chunks[0]?.start, 0)
    assert.equal(firstRead.chunks[0]?.end, Buffer.byteLength('pwd', 'utf8'))
    assert.equal(firstRead.chunks[0]?.text, 'pwd')
    assert.equal(firstRead.chunks[0]?.stream, 'stdout')

    assert.deepEqual(manager.read(session.sessionId, firstRead.nextCursor), firstRead)
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

  it('lists all unreaped sessions without exposing internal records', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
      exitedSessionTtlMs: 100,
    })

    assert.deepEqual(manager.list(), [])

    const first = manager.open({ cwd: '/tmp/one', cols: 80, rows: 24 })
    const second = manager.open({ cwd: '/tmp/two', cols: 100, rows: 30 })
    manager.write(first.sessionId, 'hello\n')

    const listed = manager.list()
    assert.deepEqual(
      listed.map(session => session.sessionId),
      [first.sessionId, second.sessionId],
    )
    assert.equal(listed[0]?.cwd, '/tmp/one')
    assert.equal(listed[0]?.state, 'running')
    assert.equal(listed[0]?.cols, 80)
    assert.equal(listed[0]?.rows, 24)
    assert.equal(listed[0]?.nextCursor, Buffer.byteLength('hello\n', 'utf8'))
    assert.equal(typeof listed[0]?.startedAt, 'number')
    assert.equal(typeof listed[0]?.lastActivityAt, 'number')

    listed[0]!.state = 'failed'
    assert.equal(manager.status(first.sessionId).state, 'running')

    manager.close(first.sessionId)
    assert.equal(
      manager.list().find(session => session.sessionId === first.sessionId)?.state,
      'closed',
    )

    manager.reapExpiredSessions(Date.now() + 101)
    assert.deepEqual(
      manager.list().map(session => session.sessionId),
      [second.sessionId],
    )
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

  it('rejects terminal sizes above the centralized maximum', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    assert.throws(
      () => manager.open({ cwd: '/tmp/project', cols: 1001 }),
      /Invalid terminal cols: 1001/,
    )

    const session = manager.open({ cwd: '/tmp/project' })
    assert.throws(
      () => manager.resize(session.sessionId, 80, 1001),
      /Invalid terminal rows: 1001/,
    )
  })

  it('routes send-signal SIGINT to driver.kill instead of writing CTRL_C', () => {
    const driver = new FakePtyDriver()
    const manager = new PtySessionManager({
      driver,
    })

    const session = manager.open({ cwd: '/tmp/project' })
    const signaled = manager.signal(session.sessionId, 'SIGINT')

    assert.equal(signaled.state, 'closed')
    assert.equal(signaled.exitCode, 130)
    assert.deepEqual(driver.killedSignals, [
      { sessionId: session.sessionId, signal: 'SIGINT' },
    ])
    assert.deepEqual(driver.writes, [])
  })

  it('keeps CTRL_C as a send-keys write sequence', () => {
    const driver = new FakePtyDriver()
    const manager = new PtySessionManager({
      driver,
    })

    const session = manager.open({ cwd: '/tmp/project' })
    manager.write(session.sessionId, '')

    assert.deepEqual(driver.killedSignals, [])
    assert.deepEqual(driver.writes, [
      { sessionId: session.sessionId, data: '' },
    ])
  })

  it('trims raw activity cursors while read keeps returning the current screen snapshot', () => {
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
    assert.equal(readFromStart.lowestAvailableCursor, 0)
    assert.equal(readFromStart.truncatedBeforeCursor, false)
    assert.equal(readFromStart.chunks.map(chunk => chunk.text).join(''), 'one\ntwo\nthree')

    const sessionStatus = manager.status(session.sessionId)
    assert.equal(sessionStatus.lowestAvailableCursor, one)
    assert.equal(sessionStatus.nextCursor, one + two + three)
    assert.equal(sessionStatus.truncatedBeforeCursor, true)

    const readFromLowestCursor = manager.read(session.sessionId, one)
    assert.deepEqual(readFromLowestCursor, readFromStart)
  })

  it('reads the current rendered screen snapshot for terminal redraws', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })
    const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

    manager.write(session.sessionId, 'Claude is thinking... 12%')
    manager.write(session.sessionId, '\rClaude is thinking... 100%')

    const snapshot = manager.read(session.sessionId, 0)
    const preview = manager.getRenderedPreview(session.sessionId)

    assert.equal(
      snapshot.chunks.map(chunk => chunk.text).join(''),
      'Claude is thinking... 100%',
    )
    assert.equal(preview.includes('Claude is thinking... 100%'), true)
  })

  it('keeps final status and rendered preview after driver close cleanup', () => {
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })
    const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

    manager.write(session.sessionId, 'Claude complete')
    manager.close(session.sessionId)

    assert.equal(manager.status(session.sessionId).state, 'closed')
    assert.equal(manager.getRenderedPreview(session.sessionId).includes('Claude complete'), true)
  })

  it('observes naturally exited driver sessions before TTL disposal', () => {
    const driver = new FakePtyDriver()
    const manager = new PtySessionManager({
      driver,
      exitedSessionTtlMs: 100,
    })
    const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

    driver.finishNaturally(session.sessionId, 'TERMINAL_L5_OK', 0)

    const status = manager.status(session.sessionId)
    assert.equal(status.state, 'closed')
    assert.equal(status.exitCode, 0)
    assert.equal(manager.getRenderedPreview(session.sessionId), 'TERMINAL_L5_OK')
    assert.equal(
      manager.read(session.sessionId, 0).chunks.map(chunk => chunk.text).join(''),
      'TERMINAL_L5_OK',
    )
    assert.equal(
      manager.list().find(item => item.sessionId === session.sessionId)?.state,
      'closed',
    )
    assert.throws(
      () => manager.write(session.sessionId, 'after close'),
      /SESSION_ALREADY_CLOSED: term-1/,
    )

    manager.reapExpiredSessions(Date.now() + 101)
    assert.deepEqual(driver.disposedSessions, [session.sessionId])
    assert.throws(() => manager.status(session.sessionId), /Unknown PTY session/)
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
