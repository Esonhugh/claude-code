#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

import type { TaskStateBase } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { TerminalTaskState } from '../../tasks/TerminalTask.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { render } from '../../ink.js'
import { getDefaultAppState } from '../../state/AppState.js'
import { AppStateProvider } from '../../state/AppState.js'
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
  args: ['-l'],
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

process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'test-key'
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: '0.0.0-test',
}

class TestStdout extends Writable {
  columns = 120
  rows = 40
  isTTY = false
  output = ''

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString()
    callback()
  }
}

const renderedTerminal = terminalTask('rendered', 1)
renderedTerminal.command = 'python'
renderedTerminal.args = ['-i', '--quiet']
const initialState = {
  ...getDefaultAppState(),
  tasks: { rendered: renderedTerminal },
}
const { BackgroundTasksDialog } = await import('./BackgroundTasksDialog.js')
const stdout = new TestStdout()
const instance = await render(
  React.createElement(
    AppStateProvider,
    { initialState } as unknown as React.ComponentProps<typeof AppStateProvider>,
    React.createElement(BackgroundTasksDialog, {
      onDone: () => {},
      toolUseContext: {} as ToolUseContext,
      initialDetailTaskId: 'rendered',
      scope: 'terminal',
    }),
  ),
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  },
)
await new Promise(resolve => setImmediate(resolve))
instance.unmount()
instance.cleanup()

assert.match(
  stripAnsi(stdout.output),
  /Command: python\s+Args: \["-i","--quiet"\]\s+CWD: \/tmp\s+Preview:/,
)

console.log('BackgroundTasksDialog.test.ts passed')
