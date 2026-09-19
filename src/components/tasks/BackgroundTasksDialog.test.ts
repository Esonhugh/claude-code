#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mock, spyOn, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

import type { TaskStateBase } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { TerminalTaskState } from '../../tasks/TerminalTask.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { render } from '../../ink.js'
import { getDefaultAppState } from '../../state/AppState.js'
import { AppStateProvider } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
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

class TestStdin extends Readable {
  isTTY = true
  isRaw = false

  _read() {}

  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
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
const stdin = new TestStdin()
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
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  },
)
await new Promise(resolve => setImmediate(resolve))
instance.unmount()
instance.cleanup()

assert.match(
  stripAnsi(stdout.output),
  /Command: python\s+Args: \["-i","--quiet"\]\s+CWD: \/tmp\s+Preview:/,
)

const { createUserMessage } = await import('../../utils/messages.js')
const retainedMessages = [createUserMessage({ content: 'retained transcript marker' })]
const retainedTeammate = {
  ...createTaskBase('worker', 'retained worker', 1),
  type: 'in_process_teammate' as const,
  status: 'completed' as const,
  retain: true,
  identity: { agentId: 'worker@team', agentName: 'worker', teamName: 'team', color: 'blue', planModeRequired: false, parentSessionId: 'session' },
  prompt: 'retained marker', messages: retainedMessages, permissionMode: 'default' as const,
  awaitingPlanApproval: false, pendingUserMessages: [], isIdle: true,
  shutdownRequested: false, lastReportedToolCount: 0, lastReportedTokenCount: 0,
}
assert.deepEqual(getBackgroundTasksDialogInitialState({ tasks: { worker: retainedTeammate } }).viewState,
  { mode: 'list' })

const { injectUserMessageToTeammate, isViewableTeammate, getViewableTeammatesSorted } = await import('../../tasks/InProcessTeammateTask/InProcessTeammateTask.js')
for (const status of ['pending', 'running', 'completed', 'failed', 'killed'] as const) {
  for (const retention of [{}, { retain: true }, { retain: false, evictAfter: Date.now() + 30_000 }]) {
    const task = { ...retainedTeammate, retain: undefined, status, ...retention }
    assert.equal(isViewableTeammate(task), status === 'running' || (status !== 'pending' && ('evictAfter' in retention || retention.retain === true)))
  }
}
const zTeammate = { ...retainedTeammate, id: 'z', identity: { ...retainedTeammate.identity, agentName: 'z' } }
assert.deepEqual(getViewableTeammatesSorted({ z: zTeammate, a: retainedTeammate }).map(t => t.id), ['worker', 'z'])

for (const status of ['completed', 'failed', 'killed'] as const) {
  let terminalState: AppState = {
    ...getDefaultAppState(),
    tasks: { worker: { ...retainedTeammate, status, pendingUserMessages: [] } },
  }
  const injected = injectUserMessageToTeammate(
    'worker',
    `${status} unsent input`,
    updater => { terminalState = updater(terminalState) },
  )
  const task = terminalState.tasks.worker as InProcessTeammateTaskState
  assert.equal(injected, false)
  assert.deepEqual(task.pendingUserMessages, [])
  assert.equal(task.messages, retainedMessages, 'rejected input must not appear as a sent transcript message')
}

let runningState: AppState = {
  ...getDefaultAppState(),
  tasks: { worker: { ...retainedTeammate, status: 'running' as const, pendingUserMessages: [] } },
}
assert.equal(injectUserMessageToTeammate(
  'worker',
  'live input',
  updater => { runningState = updater(runningState) },
), true)
const runningTask = runningState.tasks.worker as InProcessTeammateTaskState
assert.deepEqual(runningTask.pendingUserMessages, ['live input'])
const runningMessage = runningTask.messages?.at(-1)
assert.equal(runningMessage?.type, 'user')
assert.equal(
  runningMessage?.type === 'user' ? runningMessage.message.content : undefined,
  'live input',
)

const { useAppState, useSetAppState } = await import('../../state/AppState.js')
const { useBackgroundTaskNavigation } = await import('../../hooks/useBackgroundTaskNavigation.js')
const { Box, Text } = await import('../../ink.js')
let liveState = { ...getDefaultAppState(), tasks: { worker: { ...retainedTeammate, status: 'running' as const, retain: undefined } } } as ReturnType<typeof getDefaultAppState>
let updateState: ReturnType<typeof useSetAppState>
let showDialog: (value: boolean) => void
function Harness() {
  liveState = useAppState(s => s)
  updateState = useSetAppState()
  const [dialog, setDialog] = React.useState(true)
  showDialog = setDialog
  useBackgroundTaskNavigation()
  return dialog ? React.createElement(BackgroundTasksDialog, {
    onDone: () => setDialog(false), toolUseContext: {} as ToolUseContext,
  }) : React.createElement(Box, { tabIndex: 0, autoFocus: true },
    React.createElement(Text, {}, liveState.viewingAgentTaskId ? liveState.tasks[liveState.viewingAgentTaskId]?.description : 'main'))
}
const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
const interactionOut = new TestStdout()
const interactionIn = new TestStdin()
const interaction = await render(React.createElement(AppStateProvider,
  { initialState: liveState } as unknown as React.ComponentProps<typeof AppStateProvider>, React.createElement(KeybindingSetup, null, React.createElement(Harness))), {
  stdout: interactionOut as unknown as NodeJS.WriteStream, stdin: interactionIn as unknown as NodeJS.ReadStream,
  patchConsole: false, exitOnCtrlC: false,
})
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 50)) }
try {
  await flush()
  assert.match(stripAnsi(interactionOut.output), /Background tasks/)
  assert.match(stripAnsi(interactionOut.output), /@team-lead/)
  assert.match(stripAnsi(interactionOut.output), /@worker/)
  interactionIn.push('\x1b[B')
  await flush()
  interactionIn.push('\r')
  await flush()
  assert.match(stripAnsi(interactionOut.output), /idle/)
  interactionIn.push('f')
  await flush()
  assert.equal(liveState.viewingAgentTaskId, 'worker')
  updateState!(s => ({ ...s, tasks: { ...s.tasks, worker: { ...s.tasks.worker!, status: 'completed' } } }))
  await flush()
  interactionIn.push('\u001b[27u')
  await flush()
  assert.equal(liveState.viewingAgentTaskId, undefined)
  assert.equal((liveState.tasks.worker as typeof retainedTeammate)?.retain, false)
  assert.ok((liveState.tasks.worker as import('../../tasks/InProcessTeammateTask/types.js').InProcessTeammateTaskState)?.evictAfter)
  showDialog!(true)
  await flush()
  assert.match(stripAnsi(interactionOut.output), /Background tasks/)
  interactionIn.push('\x1b[B')
  await flush()
  interactionIn.push('\r')
  await flush()
  interactionIn.push('f')
  await flush()
  assert.equal(liveState.viewingAgentTaskId, 'worker')
  assert.equal((liveState.tasks.worker as typeof retainedTeammate)?.retain, true)
  assert.equal((liveState.tasks.worker as import('../../tasks/InProcessTeammateTask/types.js').InProcessTeammateTaskState)?.evictAfter, undefined)
  assert.equal(liveState.tasks.worker?.description, 'retained worker')
  assert.equal((liveState.tasks.worker as typeof retainedTeammate).messages, retainedMessages)
  assert.deepEqual(Object.keys(liveState.tasks), ['worker'])
  interactionIn.push('\u001b[27u')
  await flush()
  interactionIn.push('\u001b[1;2B')
  await flush()
  assert.equal(liveState.selectedIPAgentIndex, -1)
  interactionIn.push('\u001b[1;2B')
  await flush()
  assert.equal(liveState.selectedIPAgentIndex, 0)
  interactionIn.push('f')
  await flush()
  assert.equal(liveState.viewingAgentTaskId, 'worker')
} finally {
  interaction.unmount()
  interaction.cleanup()
}

const { default: chalk } = await import('chalk')
const previousColorLevel = chalk.level
chalk.level = 1
const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
for (const viewedId of ['worker', 'z', 'missing', undefined]) {
  const pillOut = new TestStdout()
  const pills = await render(React.createElement(AppStateProvider,
    { initialState: { ...getDefaultAppState(), viewingAgentTaskId: viewedId, tasks: {
      worker: retainedTeammate, z: { ...zTeammate, status: 'running', isIdle: false },
    } } } as unknown as React.ComponentProps<typeof AppStateProvider>,
    React.createElement(BackgroundTaskStatus, { tasksSelected: false, isViewingTeammate: viewedId !== undefined })), {
    stdout: pillOut as unknown as NodeJS.WriteStream, stdin: new TestStdin() as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  await flush()
  pills.unmount()
  pills.cleanup()
  assert.match(stripAnsi(pillOut.output), /@main\s+@z\s+@worker/)
  const expectedName = viewedId === undefined ? 'main' : viewedId
  for (const name of ['main', 'z', 'worker']) {
    assert.equal(pillOut.output.includes(`\u001b[1m@${name}`), name === expectedName, `viewed=${viewedId}, pill=${name}, output=${JSON.stringify(pillOut.output)}`)
  }
}
chalk.level = previousColorLevel
const { default: PromptInput } = await import('../PromptInput/PromptInput.js')
const onShowMessageSelector = mock(() => {})
let promptInputValue = ''
let setLocalJSXCommandActive: (active: boolean) => void
function PromptHarness() {
  liveState = useAppState(s => s)
  updateState = useSetAppState()
  useBackgroundTaskNavigation()
  const [input, setInput] = React.useState('')
  promptInputValue = input
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [isLocalJSXCommandActive, setIsLocalJSXCommandActive] = React.useState(false)
  setLocalJSXCommandActive = setIsLocalJSXCommandActive
  return React.createElement(PromptInput, {
    debug: false, ideSelection: undefined,
    toolPermissionContext: liveState.toolPermissionContext,
    setToolPermissionContext: () => {}, apiKeyStatus: 'valid',
    commands: [], agents: [], enableLocalIOCompletions: false,
    isLoading: false, verbose: false, messages: retainedMessages,
    onAutoUpdaterResult: () => {}, autoUpdaterResult: null,
    input, onInputChange: setInput, mode: 'prompt', onModeChange: () => {},
    stashedPrompt: undefined, setStashedPrompt: () => {}, submitCount: 0,
    onShowMessageSelector, mcpClients: [], pastedContents: {},
    setPastedContents: () => {}, vimMode: 'INSERT', setVimMode: () => {},
    showBashesDialog: false, setShowBashesDialog: () => {}, onExit: () => {},
    getToolUseContext: () => { throw new Error('Unexpected tool execution') },
    onSubmit: async () => { throw new Error('Unexpected prompt submission') },
    isSearchingHistory: false, setIsSearchingHistory: () => {}, helpOpen, setHelpOpen,
    isLocalJSXCommandActive,
  })
}
test('PromptInput footer keeps completed teammate pills through Escape and grace-period reopening', async () => {
  const promptOut = new TestStdout()
  const promptIn = new TestStdin()
  const promptInstance = await render(React.createElement(AppStateProvider,
    { initialState: { ...getDefaultAppState(), tasks: {
      worker: { ...retainedTeammate, status: 'running', retain: undefined },
    } } } as unknown as React.ComponentProps<typeof AppStateProvider>,
    React.createElement(KeybindingSetup, null, React.createElement(PromptHarness))), {
    stdout: promptOut as unknown as NodeJS.WriteStream,
    stdin: promptIn as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  async function pressPromptKey(key: string) {
    promptOut.output = ''
    promptIn.push(key)
    // A lone ESC is buffered for 50ms by Ink before dispatch; allow its render too.
    if (key === '\x1b') await new Promise(resolve => setTimeout(resolve, 100))
    await flush()
  }
  try {
    await flush()
    assert.match(stripAnsi(promptOut.output), /@main\s+@worker/)
    await pressPromptKey('\x1b[B')
    assert.equal(liveState.footerSelection, 'tasks', stripAnsi(promptOut.output))
    await pressPromptKey('\x1b[C')
    await pressPromptKey('\r')
    assert.equal(liveState.viewingAgentTaskId, 'worker')
    assert.equal((liveState.tasks.worker as typeof retainedTeammate).isIdle, true)
    const currentWorkAbortController = new AbortController()
    const abortController = new AbortController()
    updateState!(s => ({ ...s, tasks: { ...s.tasks, worker: {
      ...s.tasks.worker!, isIdle: false, currentWorkAbortController, abortController,
    } } }))
    await flush()
    await pressPromptKey('\x1b')
    await pressPromptKey('\x1b')
    assert.equal(currentWorkAbortController.signal.aborted, true, 'running teammate Escape aborts current turn')
    assert.equal(abortController.signal.aborted, false, 'running teammate stays alive')
    assert.equal(liveState.viewingAgentTaskId, 'worker')
    assert.equal(onShowMessageSelector.mock.calls.length, 0, 'running teammate Escape must not open Rewind')
    updateState!(s => ({ ...s, tasks: { ...s.tasks, worker: { ...s.tasks.worker!, status: 'completed' } } }))
    await flush()
    const firstEscapeAt = performance.now()
    await pressPromptKey('\x1b')
    assert.equal(liveState.viewingAgentTaskId, undefined, 'one raw Escape returns to main after footer entry')
    assert.equal(liveState.viewSelectionMode, 'none')
    assert.equal((liveState.tasks.worker as typeof retainedTeammate).retain, false)
    assert.ok((liveState.tasks.worker as import('../../tasks/InProcessTeammateTask/types.js').InProcessTeammateTaskState).evictAfter)
    assert.match(stripAnsi(promptOut.output), /@main\s+@worker/, 'real PromptInput footer keeps pills after exiting the completed teammate')
    await pressPromptKey('\x1b[B')
    await pressPromptKey('\x1b[C')
    await pressPromptKey('\r')
    assert.equal(liveState.viewingAgentTaskId, 'worker')
    assert.equal((liveState.tasks.worker as typeof retainedTeammate).retain, true)
    assert.equal((liveState.tasks.worker as import('../../tasks/InProcessTeammateTask/types.js').InProcessTeammateTaskState).evictAfter, undefined)
    assert.equal((liveState.tasks.worker as typeof retainedTeammate).messages, retainedMessages)
    await pressPromptKey('\x1b')
    assert.ok(performance.now() - firstEscapeAt < 800, 'both Escape dispatches must fit the double-press window')
    assert.equal(onShowMessageSelector.mock.calls.length, 0, 'teammate navigation must not open Rewind')
    assert.equal(liveState.viewSelectionMode, 'none')
    assert.equal(liveState.viewingAgentTaskId, undefined)
    assert.equal((liveState.tasks.worker as typeof retainedTeammate).retain, false)
    await pressPromptKey('\x1b[B')
    await pressPromptKey('\r')
    assert.equal(liveState.viewingAgentTaskId, undefined)
    assert.equal(liveState.footerSelection, null, 'selecting main clears footer selection')
    await pressPromptKey('\x1b')
    assert.equal(onShowMessageSelector.mock.calls.length, 0, 'teammate Escape must not arm the first main Escape')
    await pressPromptKey('\x1b')
    assert.equal(onShowMessageSelector.mock.calls.length, 1, 'normal main double Escape still opens Rewind')

    onShowMessageSelector.mockClear()
    setLocalJSXCommandActive!(true)
    await flush()
    await pressPromptKey('\x1b')
    await pressPromptKey('\x1b')
    assert.equal(onShowMessageSelector.mock.calls.length, 0, 'pane-owned Escape must not open Rewind')
    setLocalJSXCommandActive!(false)
    await flush()
    await pressPromptKey('\x1b')
    assert.equal(onShowMessageSelector.mock.calls.length, 0, 'pane-owned Escape must not arm the first composer Escape')
    await pressPromptKey('\x1b')
    assert.equal(onShowMessageSelector.mock.calls.length, 1, 'second composer-owned Escape opens Rewind once')

    await pressPromptKey('\x1b[1;2B')
    await pressPromptKey('\x1b[1;2B')
    assert.equal(liveState.viewSelectionMode, 'selecting-agent')
    await pressPromptKey('f')
    assert.equal(liveState.viewingAgentTaskId, 'worker')
    assert.equal(promptInputValue, '', 'navigation f must not leak into the prompt')
    await pressPromptKey('\x1b')
    assert.equal(liveState.viewingAgentTaskId, undefined)
    assert.equal(promptInputValue, '')
    assert.equal(onShowMessageSelector.mock.calls.length, 1)
    await pressPromptKey('draft')
    assert.equal(promptInputValue, 'draft')
    await pressPromptKey('\x1b[1;2B')
    await pressPromptKey('\x1b[1;2A')
    assert.equal(liveState.viewSelectionMode, 'selecting-agent')
    await pressPromptKey('k')
    assert.equal(promptInputValue, 'draft', 'navigation k preserves the draft')
    await pressPromptKey('\x1b')
    assert.equal(liveState.viewSelectionMode, 'none')
    assert.equal(liveState.viewingAgentTaskId, undefined)
    assert.equal(promptInputValue, 'draft', 'selection Escape preserves the draft')
    assert.equal(onShowMessageSelector.mock.calls.length, 1)
    await pressPromptKey('\x1b[1;2B')
    await pressPromptKey('f')
    assert.equal(liveState.viewingAgentTaskId, 'worker')
    assert.equal(promptInputValue, 'draft', 'navigation f preserves the draft')
    await pressPromptKey('\x1b')
    assert.equal(liveState.viewingAgentTaskId, undefined)
    assert.equal(promptInputValue, 'draft')
    await pressPromptKey('\x15')
    updateState!(s => ({ ...s, expandedView: 'none' }))
    await flush()

    const { isBackgroundTask } = await import('../../tasks/types.js')
    const { evictTerminalTask, getRunningTasks } = await import('../../utils/task/framework.js')
    assert.equal(isBackgroundTask(liveState.tasks.worker!), false)
    assert.deepEqual(getRunningTasks(liveState), [])
    updateState!(s => ({ ...s, tasks: { ...s.tasks, worker: { ...s.tasks.worker!, notified: true } } }))
    await flush()
    evictTerminalTask('worker', updateState!)
    await flush()
    assert.ok(liveState.tasks.worker, 'GC preserves the transcript during grace')

    const deadline = (liveState.tasks.worker as import('../../tasks/InProcessTeammateTask/types.js').InProcessTeammateTaskState).evictAfter!
    promptOut.output = ''
    const clock = spyOn(Date, 'now').mockReturnValue(deadline + 1)
    try {
      evictTerminalTask('worker', updateState!)
      await flush()
    } finally {
      clock.mockRestore()
    }
    assert.equal(liveState.tasks.worker, undefined)
    assert.doesNotMatch(stripAnsi(promptOut.output), /@main|@worker/)
    assert.match(stripAnsi(promptOut.output), /\? for shortcuts/)

    for (const status of ['completed', 'failed', 'killed'] as const) {
      promptOut.output = ''
      updateState!(s => ({ ...s, tasks: { worker: { ...retainedTeammate, status, retain: undefined } } }))
      await flush()
      assert.doesNotMatch(stripAnsi(promptOut.output), /@main|@worker/, `unretained ${status} teammate has no pills`)
      assert.equal(isBackgroundTask(liveState.tasks.worker!), false)
      assert.deepEqual(getRunningTasks(liveState), [])
    }
  } finally {
    promptInstance.unmount()
    promptInstance.cleanup()
    const { disposeKeybindingWatcher } = await import('../../keybindings/loadUserBindings.js')
    disposeKeybindingWatcher()
  }
})
test.each(['running', 'completed', 'failed', 'killed'] as const)(
  'viewed %s local agent does not leave an empty footer segment',
  async status => {
    const { PromptInputFooterLeftSide } = await import('../PromptInput/PromptInputFooterLeftSide.js')
    const state = getDefaultAppState()
    const localAgent: import('../../tasks/LocalAgentTask/LocalAgentTask.js').LocalAgentTaskState = {
      id: 'local-footer', type: 'local_agent', status,
      description: 'Footer probe', prompt: 'Footer probe',
      startTime: 1, endTime: status === 'running' ? undefined : 2,
      outputFile: '', outputOffset: 0, notified: true,
      agentId: 'local-footer', agentType: 'general-purpose', spawnDepth: 1,
      abortController: new AbortController(), retrieved: false,
      lastReportedToolCount: 0, lastReportedTokenCount: 0,
      isBackgrounded: true, pendingMessages: [], retain: true, diskLoaded: false,
    }
    const toolPermissionContext = { ...state.toolPermissionContext, mode: 'bypassPermissions' as const }
    const footerOut = new TestStdout()
    const footer = await render(React.createElement(AppStateProvider,
      { initialState: {
        ...state, toolPermissionContext, tasks: { [localAgent.id]: localAgent },
        viewingAgentTaskId: localAgent.id, viewSelectionMode: 'viewing-agent',
      } } as unknown as React.ComponentProps<typeof AppStateProvider>,
      React.createElement(KeybindingSetup, null, React.createElement(PromptInputFooterLeftSide, {
        exitMessage: { show: false }, vimMode: undefined, mode: 'prompt',
        toolPermissionContext, suppressHint: false, isLoading: false,
        tasksSelected: false, teamsSelected: false, tmuxSelected: false,
        isSearching: false, historyQuery: '', setHistoryQuery: () => {}, historyFailedMatch: false,
      }))), {
      stdout: footerOut as unknown as NodeJS.WriteStream,
      stdin: new TestStdin() as unknown as NodeJS.ReadStream,
      patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await flush()
      const output = stripAnsi(footerOut.output)
      assert.match(output, /bypass permissions on/)
      assert.match(output, /↓ to manage/)
      assert.doesNotMatch(output, /·\s*·/)
      if (status !== 'running') assert.doesNotMatch(output, /\bagents?\b/)
    } finally {
      footer.unmount()
      footer.cleanup()
      const { disposeKeybindingWatcher } = await import('../../keybindings/loadUserBindings.js')
      disposeKeybindingWatcher()
    }
  },
)
console.log('BackgroundTasksDialog.test.ts passed')
