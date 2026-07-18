import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import test, { beforeEach } from 'node:test'
import type { UUID } from 'node:crypto'

import type { ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AssistantMessage } from '../../types/message.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { FakePtyDriver } from '../../utils/pty/__fixtures__/FakePtyDriver.js'
import { PtySessionManager } from '../../utils/pty/PtySessionManager.js'
import { resolveTerminalCommand } from '../../utils/shell/resolveDefaultShell.js'
import { capturePaneActionSchema } from './actionSchemas.js'
import {
  getTerminalManager,
  TerminalTool,
  resetTerminalManagerForTesting,
  terminalTaskRegistry,
} from './TerminalTool.js'

type TestAppState = Pick<AppState, 'toolPermissionContext' | 'tasks'>
type TerminalTask = Extract<
  AppState['tasks'][string],
  { type: 'interactive_terminal' }
>

const TEST_ASSISTANT_MESSAGE: AssistantMessage = {
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000000' as UUID,
  timestamp: '1970-01-01T00:00:00.000Z',
  message: {
    id: 'msg_test',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  },
}

function createContext(): ToolUseContext {
  let appState: TestAppState = {
    toolPermissionContext: { mode: 'default' } as AppState['toolPermissionContext'],
    tasks: {},
  }

  return {
    options: {
      tools: [],
      mcpClients: [],
      mcpResources: {},
      debug: false,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      commands: [],
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
        allowedAgentTypes: undefined,
      },
      mainLoopModel: 'claude-sonnet-4-6',
    },
    abortController: new AbortController(),
    readFileState: new FileStateCache(8, 8 * 1024),
    getAppState: () => appState as AppState,
    setAppState: updater => {
      appState = updater(appState as AppState) as TestAppState
    },
    setInProgressToolUseIDs: _updater => {},
    setResponseLength: _updater => {},
    updateFileHistoryState: _updater => {},
    updateAttributionState: _updater => {},
    messages: [],
  }
}

const allowPermission: CanUseToolFn = async () => ({ behavior: 'allow' })

function createFakeTerminalManager(): PtySessionManager {
  return new PtySessionManager({
    driver: new FakePtyDriver(),
    maxBufferedChunks: 200,
  })
}

beforeEach(() => {
  resetTerminalManagerForTesting(createFakeTerminalManager())
})

test('TerminalTool exposes the Terminal tool name without old alias', () => {
  assert.equal(TerminalTool.name, 'Terminal')
  assert.notEqual(TerminalTool.name, 'InteractiveTerminal')
})

test('new-session auto classifier includes executable argv without env values', () => {
  assert.equal(
    TerminalTool.toAutoClassifierInput({
      action: 'new-session',
      command: 'python',
      args: ['-i'],
      env: { SECRET_TOKEN: 'do-not-display' },
    }),
    'new-session command=python args=["-i"]',
  )
  assert.equal(
    TerminalTool.toAutoClassifierInput({ action: 'new-session' }),
    'new-session command=<default-shell>',
  )
})

test('action schema exposes only tmux-style Terminal actions', () => {
  for (const action of [
    'new-session',
    'list-panes',
    'send-keys',
    'capture-pane',
    'resize-pane',
    'send-signal',
    'display-message',
    'kill-pane',
  ]) {
    assert.equal(TerminalTool.inputSchema.safeParse({ action }).success, true)
  }

  for (const action of ['open', 'list', 'write', 'read', 'send_key', 'resize', 'signal', 'status', 'close']) {
    assert.equal(TerminalTool.inputSchema.safeParse({ action }).success, false)
  }
})

test('capture-pane action schema defaults to compact compression options', () => {
  const input = capturePaneActionSchema.parse({
    action: 'capture-pane',
    target: 'sess-1',
  })

  assert.equal(input.mode, 'compact')
  assert.equal(input.maxBytes, 8192)
  assert.equal(input.maxLines, 80)
  assert.equal(input.maxLineChars, 240)
  assert.equal(input.previewBytes, 2000)
  assert.equal(input.cursor, 0)
})

test('resetTerminalManagerForTesting clears open terminal panes', async () => {
  const opened = await TerminalTool.call(
    { action: 'new-session', cwd: process.cwd(), cols: 80, rows: 24 },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal('error' in opened.data, false)

  resetTerminalManagerForTesting()

  const listed = await TerminalTool.call(
    { action: 'list-panes' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((listed.data as { count: number }).count, 0)
})

test('rejects send-keys action without target and text or key', async () => {
  const result = await TerminalTool.call(
    { action: 'send-keys' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.match(JSON.stringify(result.data), /INVALID_ACTION_INPUT/)
  assert.match(JSON.stringify(result.data), /target and text or key/)
})

test('rejects unknown actions with INVALID_ACTION', async () => {
  const result = await TerminalTool.call(
    { action: 'unknown_action' } as unknown as Parameters<
      typeof TerminalTool.call
    >[0],
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal(
    (result.data as { error: { code: string; message: string } }).error.code,
    'INVALID_ACTION',
  )
  assert.match(
    (result.data as { error: { code: string; message: string } }).error.message,
    /Unsupported action: unknown_action/,
  )
})

test('accepts a valid new-session action and returns a pane', async () => {
  const result = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal('error' in result.data, false)
  const target = String((result.data as { target: string }).target)
  assert.match(target, /^term-/)
  assert.equal(typeof (result.data as { pid: number | null }).pid, 'number')

  const closed = await TerminalTool.call(
    { action: 'kill-pane', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal((closed.data as { closed: boolean }).closed, true)
})

test('lists unreaped panes without requiring a target', async () => {
  const emptyList = await TerminalTool.call(
    { action: 'list-panes' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal((emptyList.data as { count: number }).count, 0)
  assert.deepEqual((emptyList.data as { panes: unknown[] }).panes, [])

  const first = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const second = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const firstSessionId = String((first.data as { target: string }).target)
  const secondSessionId = String((second.data as { target: string }).target)

  const listed = await TerminalTool.call(
    { action: 'list-panes' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const listedSessions = (listed.data as { panes: Array<{ target: string; state: string }> }).panes
  assert.equal((listed.data as { count: number }).count, 2)
  assert.deepEqual(
    listedSessions.map(pane => pane.target),
    [firstSessionId, secondSessionId],
  )

  await TerminalTool.call(
    { action: 'kill-pane', target: firstSessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const afterClose = await TerminalTool.call(
    { action: 'list-panes' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal(
    (afterClose.data as { panes: Array<{ target: string; state: string }> }).panes.find(
      pane => pane.target === firstSessionId,
    )?.state,
    'closed',
  )

  await TerminalTool.call(
    { action: 'kill-pane', target: secondSessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('routes new-session, display-message, send-keys, capture-pane, and kill-pane through the shared pane manager', async () => {
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  const status = await TerminalTool.call(
    { action: 'display-message', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((status.data as { isRunning: boolean }).isRunning, true)
  assert.equal(typeof (status.data as { pid: number | null }).pid, 'number')
  assert.equal(
    typeof (status.data as { lastActivityAt: number }).lastActivityAt,
    'number',
  )

  const sendKeysResult = await TerminalTool.call(
    { action: 'send-keys', target, text: 'echo test', enter: true },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((sendKeysResult.data as { accepted: boolean }).accepted, true)

  const readResult = await TerminalTool.call(
    { action: 'capture-pane', target, cursor: 0, maxBytes: 4096 },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal(typeof (readResult.data as { text: string }).text, 'string')
  assert.equal(
    typeof (readResult.data as { isRunning: boolean }).isRunning,
    'boolean',
  )
  assert.equal(
    'exitCode' in (readResult.data as { exitCode: number | null }),
    true,
  )

  const closeResult = await TerminalTool.call(
    { action: 'kill-pane', target, force: false },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((closeResult.data as { closed: boolean }).closed, true)
})

test('capture-pane modes work through TerminalTool.call', async () => {
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 120,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  const repeatedText = [
    'start',
    ...Array.from({ length: 6 }, () => 'repeat'),
    'end',
  ].join('\n')

  await TerminalTool.call(
    { action: 'send-keys', target, text: `${repeatedText}\n` },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const compact = await TerminalTool.call(
    {
      action: 'capture-pane',
      target,
      mode: 'compact',
      maxBytes: 8192,
      maxLines: 80,
      maxLineChars: 240,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((compact.data as { mode: string }).mode, 'compact')
  assert.match(
    (compact.data as { text: string }).text,
    /\[\.\.\. repeated \d+ more times \.\.\.\]/,
  )

  const full = await TerminalTool.call(
    { action: 'capture-pane', target, mode: 'full', maxBytes: 8192 },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((full.data as { mode: string }).mode, 'full')
  assert.equal((full.data as { text: string }).text, repeatedText)

  const saved = await TerminalTool.call(
    {
      action: 'capture-pane',
      target,
      mode: 'save_file',
      previewBytes: 2000,
      maxLines: 80,
      maxLineChars: 240,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const savedData = saved.data as {
    filePath: string
    mode: string
    preview: string
  }
  assert.equal(savedData.mode, 'save_file')
  assert.ok(existsSync(savedData.filePath))
  try {
    assert.equal(readFileSync(savedData.filePath, 'utf8'), repeatedText)
    assert.match(savedData.preview, /\[\.\.\. repeated \d+ more times \.\.\.\]/)
  } finally {
    rmSync(savedData.filePath, { force: true })
  }

  await TerminalTool.call(
    { action: 'kill-pane', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('accepts send-keys text, key, and enter on an existing pane', async () => {
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  const keyResult = await TerminalTool.call(
    { action: 'send-keys', target, text: 'echo hi', key: 'CTRL_C', enter: true },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((keyResult.data as { accepted: boolean }).accepted, true)

  const enterOnlyResult = await TerminalTool.call(
    { action: 'send-keys', target, enter: true },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((enterOnlyResult.data as { accepted: boolean }).accepted, true)

  await TerminalTool.call(
    { action: 'kill-pane', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('returns SESSION_NOT_FOUND for a missing pane', async () => {
  const result = await TerminalTool.call(
    { action: 'capture-pane', target: 'missing-pane', cursor: 0, maxBytes: 128 },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal(
    (result.data as { error: { code: string } }).error.code,
    'SESSION_NOT_FOUND',
  )
})

test('records the resolved default shell in task state for new-session', async () => {
  const context = createContext()
  const result = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal('error' in result.data, false)
  const target = String((result.data as { target: string }).target)
  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )

  assert.equal(task?.command, resolveTerminalCommand().command)

  await TerminalTool.call(
    { action: 'kill-pane', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('prompts for permission on new-session but not on display-message or list-panes for an approved pane', async () => {
  const permissionCalls: string[] = []
  const canUseTool: CanUseToolFn = async (_tool, input) => {
    permissionCalls.push(String(input.action ?? 'new-session'))
    return { behavior: 'allow' }
  }

  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    canUseTool,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  await TerminalTool.call(
    { action: 'display-message', target },
    createContext(),
    canUseTool,
    TEST_ASSISTANT_MESSAGE,
  )
  await TerminalTool.call(
    { action: 'list-panes' },
    createContext(),
    canUseTool,
    TEST_ASSISTANT_MESSAGE,
  )

  await TerminalTool.call(
    { action: 'kill-pane', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.deepEqual(permissionCalls, ['new-session'])
})

test('refreshes task preview on display-message for large terminal redraw output', async () => {
  const context = createContext()
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  const taskBefore = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.ok(taskBefore)

  const initialCursor = (await TerminalTool.call(
    { action: 'capture-pane', target, cursor: 0, maxBytes: 4096 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )).data as { toCursor: number }

  getTerminalManager().write(target, 'Claude is thinking... 12%')
  getTerminalManager().write(target, '\rClaude is thinking... 100%')

  await TerminalTool.call(
    { action: 'display-message', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const taskAfter = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )

  assert.equal(taskAfter?.preview, 'Claude is thinking... 100%')

  const readAfterStatus = await TerminalTool.call(
    { action: 'capture-pane', target, cursor: initialCursor.toCursor, maxBytes: 4096 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal(
    (readAfterStatus.data as { text: string }).text,
    'Claude is thinking... 100%',
  )

  await TerminalTool.call(
    { action: 'kill-pane', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('syncs naturally exited panes to completed task state while preserving final preview', async () => {
  const driver = new FakePtyDriver()
  resetTerminalManagerForTesting(new PtySessionManager({ driver }))
  const context = createContext()
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      command: '/bin/sh',
      args: ['-c', 'printf TERMINAL_L5_OK'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  driver.finishNaturally(target, 'TERMINAL_L5_OK', 0)

  const captured = await TerminalTool.call(
    { action: 'capture-pane', target, cursor: 0, maxBytes: 4096 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((captured.data as { text: string }).text, 'TERMINAL_L5_OK')
  assert.equal((captured.data as { isRunning: boolean }).isRunning, false)

  const status = await TerminalTool.call(
    { action: 'display-message', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((status.data as { isRunning: boolean }).isRunning, false)
  assert.equal((status.data as { exitCode: number }).exitCode, 0)

  const listed = await TerminalTool.call(
    { action: 'list-panes' },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal(
    (listed.data as { panes: Array<{ target: string; state: string }> }).panes.find(
      pane => pane.target === target,
    )?.state,
    'closed',
  )

  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.preview, 'TERMINAL_L5_OK')
  assert.equal(task?.closed, true)
  assert.equal(task?.status, 'completed')
})

test('preserves send-signal semantics by invoking driver kill', async () => {
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  const signaled = await TerminalTool.call(
    { action: 'send-signal', target, signal: 'SIGINT' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((signaled.data as { accepted: boolean }).accepted, true)

  const status = await TerminalTool.call(
    { action: 'display-message', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((status.data as { exitCode: number }).exitCode, 130)
})

test('TerminalTask.kill stops runtime session and clears registry', async () => {
  const context = createContext()
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.ok(task)

  const { TerminalTask: RuntimeTerminalTask } = await import('../../tasks/TerminalTask.js')
  await RuntimeTerminalTask.kill(task.id, context.setAppState)

  assert.equal(terminalTaskRegistry.has(target), false)
  assert.equal(getTerminalManager().status(target).state, 'closed')
  assert.equal(
    (context.getAppState().tasks[task.id] as TerminalTask).status,
    'killed',
  )
})

test('returns SESSION_ALREADY_CLOSED when writing to a closed pane', async () => {
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  await TerminalTool.call(
    { action: 'kill-pane', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const sendKeysAfterClose = await TerminalTool.call(
    { action: 'send-keys', target, text: 'pwd', enter: true },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal(
    (sendKeysAfterClose.data as { error: { code: string } }).error.code,
    'SESSION_ALREADY_CLOSED',
  )
})
