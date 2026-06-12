import assert from 'node:assert/strict'
import test from 'node:test'

import { InteractiveTerminalTool } from './InteractiveTerminalTool.ts'
import { resolveInteractiveTerminalCommand } from '../../utils/shell/resolveDefaultShell.ts'

function createContext() {
  let appState = {
    toolPermissionContext: { mode: 'default' },
    tasks: {},
  }

  return {
    options: {
      tools: [],
      mcpClients: [],
      mcpResources: {},
      debug: false,
      verbose: false,
      thinkingConfig: {},
      commands: [],
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      mainLoopModel: 'claude-sonnet-4-6',
    },
    abortController: new AbortController(),
    readFileState: {} as never,
    getAppState: () => appState as never,
    setAppState: (updater: (prev: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as never
}

async function allowPermission() {
  return { behavior: 'allow' as const }
}

test('rejects write action without sessionId and text', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'write' } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.match(JSON.stringify(result.data), /INVALID_ACTION_INPUT/)
  assert.match(JSON.stringify(result.data), /sessionId and text/)
})

test('rejects unknown actions with INVALID_ACTION', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'unknown_action' } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.equal((result.data as { error: { code: string; message: string } }).error.code, 'INVALID_ACTION')
  assert.match((result.data as { error: { code: string; message: string } }).error.message, /Unsupported action: unknown_action/)
})

test('accepts a valid open action and returns a session', async () => {
  const result = await InteractiveTerminalTool.call(
    {
      action: 'open',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.equal('error' in result.data, false)
  const sessionId = String((result.data as { sessionId: string }).sessionId)
  assert.match(sessionId, /^session-/)
  assert.equal(typeof (result.data as { pid: number | null }).pid, 'number')

  const closed = await InteractiveTerminalTool.call(
    { action: 'close', sessionId } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.equal((closed.data as { closed: boolean }).closed, true)
})

test('routes open, status, write, read, and close through the shared session manager', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const status = await InteractiveTerminalTool.call(
    { action: 'status', sessionId } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal((status.data as { isRunning: boolean }).isRunning, true)
  assert.equal(typeof (status.data as { pid: number | null }).pid, 'number')
  assert.equal(typeof (status.data as { lastActivityAt: number }).lastActivityAt, 'number')

  const writeResult = await InteractiveTerminalTool.call(
    { action: 'write', sessionId, text: 'echo test', enter: true } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal((writeResult.data as { accepted: boolean }).accepted, true)

  const readResult = await InteractiveTerminalTool.call(
    { action: 'read', sessionId, cursor: 0, maxBytes: 4096 } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal(typeof (readResult.data as { text: string }).text, 'string')
  assert.equal(typeof (readResult.data as { isRunning: boolean }).isRunning, 'boolean')
  assert.equal('exitCode' in (readResult.data as { exitCode: number | null }), true)

  const closeResult = await InteractiveTerminalTool.call(
    { action: 'close', sessionId, force: false } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal((closeResult.data as { closed: boolean }).closed, true)
})

test('accepts send_key on an existing session', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const keyResult = await InteractiveTerminalTool.call(
    { action: 'send_key', sessionId, key: 'CTRL_C' } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal((keyResult.data as { accepted: boolean }).accepted, true)

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
})

test('returns SESSION_NOT_FOUND for a missing session', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'read', sessionId: 'missing-session', cursor: 0, maxBytes: 128 } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.equal((result.data as { error: { code: string } }).error.code, 'SESSION_NOT_FOUND')
})

test('records the resolved default shell in task state when open omits command', async () => {
  const context = createContext()
  const result = await InteractiveTerminalTool.call(
    {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    context,
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.equal('error' in result.data, false)
  const sessionId = String((result.data as { sessionId: string }).sessionId)
  const task = Object.values((context.getAppState() as any).tasks).find(
    (value: any) => value.sessionId === sessionId,
  ) as { command?: string } | undefined

  assert.equal(task?.command, resolveInteractiveTerminalCommand())

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId } as never,
    context,
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
})

test('prompts for permission on open but not on status for an approved session', async () => {
  const permissionCalls: string[] = []
  const canUseTool = async (input: { input?: { action?: string } }) => {
    permissionCalls.push(String(input.input?.action ?? 'open'))
    return { behavior: 'allow' as const }
  }

  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    createContext(),
    canUseTool as never,
    { message: { id: 'msg_test' } } as never,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  await InteractiveTerminalTool.call(
    { action: 'status', sessionId } as never,
    createContext(),
    canUseTool as never,
    { message: { id: 'msg_test' } } as never,
  )

  await InteractiveTerminalTool.call(
    { action: 'close', sessionId } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.deepEqual(permissionCalls, ['open'])
})

test('preserves SIGTERM semantics on signal action', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  const signaled = await InteractiveTerminalTool.call(
    { action: 'signal', sessionId, signal: 'SIGTERM' } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal((signaled.data as { accepted: boolean }).accepted, true)

  const status = await InteractiveTerminalTool.call(
    { action: 'status', sessionId } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )
  assert.equal((status.data as { exitCode: number }).exitCode, 143)
})

test('returns SESSION_ALREADY_CLOSED when writing to a closed session', async () => {
  const opened = await InteractiveTerminalTool.call(
    {
      action: 'open',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  const sessionId = String((opened.data as { sessionId: string }).sessionId)
  await InteractiveTerminalTool.call(
    { action: 'close', sessionId } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  const writeAfterClose = await InteractiveTerminalTool.call(
    { action: 'write', sessionId, text: 'pwd', enter: true } as never,
    createContext(),
    allowPermission,
    { message: { id: 'msg_test' } } as never,
  )

  assert.equal((writeAfterClose.data as { error: { code: string } }).error.code, 'SESSION_ALREADY_CLOSED')
})
