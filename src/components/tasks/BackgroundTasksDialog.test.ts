#!/usr/bin/env bun
import assert from 'node:assert/strict'

import type { TaskStateBase } from '../../Task.js'
import type { TerminalTaskState } from '../../tasks/TerminalTask.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { getBackgroundTasksDialogInitialState } from './backgroundTasksDialogState.js'

function createTaskBase(id: string, description: string, startTime: number): TaskStateBase {
  return {
    id,
    type: 'interactive_terminal',
    status: 'running',
    description,
    startTime,
    outputFile: '',
    outputOffset: 0,
    notified: false,
  }
}

const terminalTask = (
  id: string,
  startTime: number,
): TerminalTaskState => ({
  ...createTaskBase(id, `terminal ${id}`, startTime),
  type: 'interactive_terminal',
  sessionId: `session-${id}`,
  command: 'zsh',
  cwd: '/tmp',
  cols: 120,
  rows: 30,
  preview: '',
  closed: false,
})

const shellTask = (id: string, startTime: number): LocalShellTaskState => ({
  ...createTaskBase(id, 'sleep 10', startTime),
  type: 'local_bash',
  command: 'sleep 10',
  completionStatusSentInAttachment: false,
  shellCommand: null,
  lastReportedTotalLines: 0,
  isBackgrounded: true,
  kind: 'bash',
})

const singleInteractive = getBackgroundTasksDialogInitialState({
  tasks: {
    shell: shellTask('shell', 1),
    term: terminalTask('term', 2),
  },
  scope: 'terminal',
})
assert.deepEqual(singleInteractive, {
  viewState: { mode: 'detail', itemId: 'term' },
  skippedListOnMount: true,
  initialSelectedIndex: 0,
})

const multipleInteractive = getBackgroundTasksDialogInitialState({
  tasks: {
    shell: shellTask('shell', 1),
    termA: terminalTask('termA', 3),
    termB: terminalTask('termB', 2),
  },
  scope: 'terminal',
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
  scope: 'terminal',
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
