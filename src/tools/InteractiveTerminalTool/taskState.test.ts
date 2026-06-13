#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { InteractiveTerminalTaskState } from '../../tasks/InteractiveTerminalTask.js'
import { syncInteractiveTerminalTaskAfterStatus } from './taskState.js'

function createTask(
  overrides: Partial<InteractiveTerminalTaskState> = {},
): InteractiveTerminalTaskState {
  return {
    id: 'i-test',
    type: 'interactive_terminal',
    status: 'running',
    description: 'Interactive terminal session-1',
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

describe('syncInteractiveTerminalTaskAfterStatus', () => {
  it('refreshes preview from rendered large terminal output', () => {
    const updated = syncInteractiveTerminalTaskAfterStatus(createTask(), {
      isRunning: true,
      preview: 'Claude is thinking... 100%',
    })

    assert.equal(updated.preview, 'Claude is thinking... 100%')
    assert.equal(updated.closed, false)
  })

  it('preserves the existing preview when status has no new rendered preview', () => {
    const updated = syncInteractiveTerminalTaskAfterStatus(
      createTask({ preview: 'existing preview' }),
      {
        isRunning: false,
        preview: '',
      },
    )

    assert.equal(updated.preview, 'existing preview')
    assert.equal(updated.closed, true)
  })
})
