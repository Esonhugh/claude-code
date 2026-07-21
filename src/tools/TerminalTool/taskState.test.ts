#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { TerminalTaskState } from '../../tasks/TerminalTask.js'
import { syncTerminalTaskAfterStatus } from './taskState.js'

function createTask(
  overrides: Partial<TerminalTaskState> = {},
): TerminalTaskState {
  return {
    id: 'i-test',
    type: 'interactive_terminal',
    status: 'running',
    description: 'Terminal session-1',
    startTime: 1,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    sessionId: 'session-1',
    command: 'bash',
    cwd: '/tmp',
    cols: 120,
    rows: 30,
    preview: '',
    closed: false,
    ...overrides,
  }
}

describe('syncTerminalTaskAfterStatus', () => {
  it('refreshes preview from rendered large terminal output', () => {
    const task = createTask()
    const updated = syncTerminalTaskAfterStatus(task, {
      status: { state: 'running' },
      preview: 'Claude is thinking... 100%',
    })

    assert.equal(updated.preview, 'Claude is thinking... 100%')
    assert.equal(updated.closed, false)
    assert.equal(
      syncTerminalTaskAfterStatus(updated, {
        status: { state: 'running' },
        preview: 'Claude is thinking... 100%',
      }),
      updated,
    )
  })

  it('preserves the existing preview and completes a successful natural exit', () => {
    const updated = syncTerminalTaskAfterStatus(
      createTask({ preview: 'existing preview' }),
      {
        status: { state: 'closed', exitCode: 0, signal: null },
        preview: '',
      },
    )

    assert.equal(updated.preview, 'existing preview')
    assert.equal(updated.closed, true)
    assert.equal(updated.status, 'completed')
    assert.equal(updated.exitCode, 0)
    assert.equal(updated.notified, false)
    assert.equal(typeof updated.endTime, 'number')
  })

  it('marks a non-zero natural exit and driver failure as failed', () => {
    const nonZero = syncTerminalTaskAfterStatus(createTask(), {
      status: { state: 'closed', exitCode: 7, signal: null },
      preview: 'failed output',
    })
    const driverFailure = syncTerminalTaskAfterStatus(createTask(), {
      status: { state: 'failed' },
      preview: '',
      error: 'driver disconnected',
    })

    assert.equal(nonZero.status, 'failed')
    assert.equal(nonZero.exitCode, 7)
    assert.equal(driverFailure.status, 'failed')
    assert.equal(driverFailure.terminalError, 'driver disconnected')
  })

  it('marks signal and explicit close termination as killed', () => {
    const signaled = syncTerminalTaskAfterStatus(createTask(), {
      status: { state: 'closed', exitCode: 130, signal: 'SIGINT' },
      preview: '',
      terminationReason: 'signal',
    })
    const closed = syncTerminalTaskAfterStatus(createTask(), {
      status: { state: 'closed', exitCode: 0, signal: null },
      preview: '',
      terminationReason: 'kill-pane',
    })

    assert.equal(signaled.status, 'killed')
    assert.equal(signaled.signal, 'SIGINT')
    assert.equal(closed.status, 'killed')
  })

  it('does not overwrite an existing terminal state', () => {
    const task = createTask({
      status: 'failed',
      closed: true,
      exitCode: 7,
      endTime: 10,
    })

    assert.equal(
      syncTerminalTaskAfterStatus(task, {
        status: { state: 'closed', exitCode: 0, signal: null },
        preview: 'late preview',
        terminationReason: 'kill-pane',
      }),
      task,
    )
  })
})
