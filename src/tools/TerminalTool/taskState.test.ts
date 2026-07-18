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
    const updated = syncTerminalTaskAfterStatus(createTask(), {
      isRunning: true,
      preview: 'Claude is thinking... 100%',
    })

    assert.equal(updated.preview, 'Claude is thinking... 100%')
    assert.equal(updated.closed, false)
  })

  it('preserves the existing preview and completes the task when status is closed', () => {
    const updated = syncTerminalTaskAfterStatus(
      createTask({ preview: 'existing preview' }),
      {
        isRunning: false,
        preview: '',
      },
    )

    assert.equal(updated.preview, 'existing preview')
    assert.equal(updated.closed, true)
    assert.equal(updated.status, 'completed')
    assert.equal(typeof updated.endTime, 'number')
  })
})
