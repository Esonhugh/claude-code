#!/usr/bin/env bun
import assert from 'node:assert/strict'

import { getBackgroundTasksDialogInitialState } from './backgroundTasksDialogState.ts'

const interactiveTerminalTask = (id: string, startTime: number) =>
  ({
    id,
    type: 'interactive_terminal',
    status: 'running',
    sessionId: `session-${id}`,
    command: 'zsh',
    cwd: '/tmp',
    preview: '',
    description: `terminal ${id}`,
    startTime,
    closed: false,
  }) as any

const shellTask = (id: string, startTime: number) =>
  ({
    id,
    type: 'local_bash',
    status: 'running',
    command: 'sleep 10',
    description: 'sleep 10',
    kind: 'bash',
    startTime,
  }) as any

const singleInteractive = getBackgroundTasksDialogInitialState({
  tasks: {
    shell: shellTask('shell', 1),
    term: interactiveTerminalTask('term', 2),
  },
  scope: 'interactive-terminal',
})
assert.deepEqual(singleInteractive, {
  viewState: { mode: 'detail', itemId: 'term' },
  skippedListOnMount: true,
  initialSelectedIndex: 0,
})

const multipleInteractive = getBackgroundTasksDialogInitialState({
  tasks: {
    shell: shellTask('shell', 1),
    termA: interactiveTerminalTask('termA', 3),
    termB: interactiveTerminalTask('termB', 2),
  },
  scope: 'interactive-terminal',
})
assert.deepEqual(multipleInteractive, {
  viewState: { mode: 'list' },
  skippedListOnMount: false,
  initialSelectedIndex: 0,
})

const noInteractive = getBackgroundTasksDialogInitialState({
  tasks: {
    shell: shellTask('shell', 1),
  },
  scope: 'interactive-terminal',
})
assert.deepEqual(noInteractive, {
  viewState: { mode: 'list' },
  skippedListOnMount: false,
  initialSelectedIndex: 0,
})

const defaultScope = getBackgroundTasksDialogInitialState({
  tasks: {
    shell: shellTask('shell', 1),
  },
})
assert.deepEqual(defaultScope, {
  viewState: { mode: 'detail', itemId: 'shell' },
  skippedListOnMount: true,
  initialSelectedIndex: 0,
})

console.log('BackgroundTasksDialog.test.ts passed')
