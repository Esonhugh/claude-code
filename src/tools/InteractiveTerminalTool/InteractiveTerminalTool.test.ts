import assert from 'node:assert/strict'
import test from 'node:test'
import type { UUID } from 'node:crypto'

import type { ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AssistantMessage } from '../../types/message.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { resolveInteractiveTerminalCommand } from '../../utils/shell/resolveDefaultShell.js'
import {
  getTerminalManager,
  InteractiveTerminalTool,
} from './InteractiveTerminalTool.js'

type TestAppState = Pick<AppState, 'toolPermissionContext' | 'tasks'>
type InteractiveTerminalTask = Extract<
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

test('rejects write action without sessionId and text', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'write' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.match(JSON.stringify(result.data), /INVALID_ACTION_INPUT/)
  assert.match(JSON.stringify(result.data), /sessionId and text/)
})

test('rejects unknown actions with INVALID_ACTION', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'unknown_action' } as unknown as Parameters<
      typeof InteractiveTerminalTool.call
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

test('accepts a valid open action and returns a session', async () => {
  const result = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal('error' in result.data, false)
  const sessionId = String((result.data as { sessionId: string }).sessionId)
  assert.match(sessionId, /^session-/)
  assert.equal(typeof (result.data as { pid: number | null }).pid, 'number')

  const closed = await InteractiveTerminalTool.call(
    { action: 'close', sessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal((closed.data as { closed: boolean }).closed, true)
})

test('lists unreaped sessions without requiring a sessionId', async () => {
  const emptyList = await InteractiveTerminalTool.call(
    { action: 'list' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal((emptyList.data as { count: number }).count, 0)
  assert.deepEqual((emptyList.data as { sessions: unknown[] }).sessions, [])

  const first = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const second = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const firstSessionId = String((first.data as { sessionId: string }).sessionId)
  const secondSessionId = String((second.data as { sessionId: string }).sessionId)

  const listed = await InteractiveTerminalTool.call(
    { action: 'list' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const listedSessions = (listed.data as { sessions: Array<{ sessionId: string; state: string }> }).sessions
  assert.equal((listed.data as { count: number }).count, 2)
  assert.deepEqual(
    listedSessions.map(session => session.sessionId),
    [firstSessionId, secondSessionId],
  )

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId: firstSessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const afterClose = await InteractiveTerminalTool.call(
    { action: 'list' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal(
    (afterClose.data as { sessions: Array<{ sessionId: string; state: string }> }).sessions.find(
      session => session.sessionId === firstSessionId,
    )?.state,
    'closed',
  )

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId: secondSessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('routes open, status, write, read, and close through the shared session manager', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const status = await InteractiveTerminalTool.call(
    { action: 'status', sessionId },
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

  const writeResult = await InteractiveTerminalTool.call(
    { action: 'write', sessionId, text: 'echo test', enter: true },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((writeResult.data as { accepted: boolean }).accepted, true)

  const readResult = await InteractiveTerminalTool.call(
    { action: 'read', sessionId, cursor: 0, maxBytes: 4096 },
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

  const closeResult = await InteractiveTerminalTool.call(
    { action: 'close', sessionId, force: false },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((closeResult.data as { closed: boolean }).closed, true)
})

test('accepts send_key on an existing session', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const keyResult = await InteractiveTerminalTool.call(
    { action: 'send_key', sessionId, key: 'CTRL_C' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((keyResult.data as { accepted: boolean }).accepted, true)

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('returns SESSION_NOT_FOUND for a missing session', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'read', sessionId: 'missing-session', cursor: 0, maxBytes: 128 },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal(
    (result.data as { error: { code: string } }).error.code,
    'SESSION_NOT_FOUND',
  )
})

test('records the resolved default shell in task state for open', async () => {
  const context = createContext()
  const result = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal('error' in result.data, false)
  const sessionId = String((result.data as { sessionId: string }).sessionId)
  const task = Object.values(context.getAppState().tasks).find(
    (value): value is InteractiveTerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === sessionId,
  )

  assert.equal(task?.command, resolveInteractiveTerminalCommand())

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('prompts for permission on open but not on status or list for an approved session', async () => {
  const permissionCalls: string[] = []
  const canUseTool: CanUseToolFn = async (_tool, input) => {
    permissionCalls.push(String(input.action ?? 'open'))
    return { behavior: 'allow' }
  }

  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    canUseTool,
    TEST_ASSISTANT_MESSAGE,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  await InteractiveTerminalTool.call(
    { action: 'status', sessionId },
    createContext(),
    canUseTool,
    TEST_ASSISTANT_MESSAGE,
  )
  await InteractiveTerminalTool.call(
    { action: 'list' },
    createContext(),
    canUseTool,
    TEST_ASSISTANT_MESSAGE,
  )

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.deepEqual(permissionCalls, ['open'])
})

test('refreshes task preview on status for large terminal redraw output', async () => {
  const context = createContext()
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const taskBefore = Object.values(context.getAppState().tasks).find(
    (value): value is InteractiveTerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === sessionId,
  )
  assert.ok(taskBefore)

  const initialCursor = (await InteractiveTerminalTool.call(
    { action: 'read', sessionId, cursor: 0, maxBytes: 4096 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )).data as { toCursor: number }

  getTerminalManager().write(sessionId, 'Claude is thinking... 12%')
  getTerminalManager().write(sessionId, '\rClaude is thinking... 100%')

  await InteractiveTerminalTool.call(
    { action: 'status', sessionId },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const taskAfter = Object.values(context.getAppState().tasks).find(
    (value): value is InteractiveTerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === sessionId,
  )

  assert.equal(taskAfter?.preview, 'Claude is thinking... 100%')

  const readAfterStatus = await InteractiveTerminalTool.call(
    { action: 'read', sessionId, cursor: initialCursor.toCursor, maxBytes: 4096 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal(
    (readAfterStatus.data as { text: string }).text,
    'Claude is thinking... 12%\rClaude is thinking... 100%',
  )

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('preserves SIGTERM semantics on signal action', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const signaled = await InteractiveTerminalTool.call(
    { action: 'signal', sessionId, signal: 'SIGTERM' },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((signaled.data as { accepted: boolean }).accepted, true)

  const status = await InteractiveTerminalTool.call(
    { action: 'status', sessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((status.data as { exitCode: number }).exitCode, 143)
})

test('returns SESSION_ALREADY_CLOSED when writing to a closed session', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  await InteractiveTerminalTool.call(
    { action: 'close', sessionId },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const writeAfterClose = await InteractiveTerminalTool.call(
    { action: 'write', sessionId, text: 'pwd', enter: true },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.equal(
    (writeAfterClose.data as { error: { code: string } }).error.code,
    'SESSION_ALREADY_CLOSED',
  )
})
