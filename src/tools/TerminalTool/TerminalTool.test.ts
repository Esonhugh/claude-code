import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import test, { beforeEach, mock } from 'node:test'
import type { UUID } from 'node:crypto'

import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AssistantMessage } from '../../types/message.js'
import { runCleanupFunctions } from '../../utils/cleanupRegistry.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { FakePtyDriver } from '../../utils/pty/__fixtures__/FakePtyDriver.js'
import type { PtyDriverOpenOptions } from '../../utils/pty/types.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { PtySessionManager } from '../../utils/pty/PtySessionManager.js'
import { resolveTerminalCommand } from '../../utils/shell/resolveDefaultShell.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { isDeferredTool, formatDeferredToolLines } from '../ToolSearchTool/prompt.js'
import { capturePaneActionSchema } from './actionSchemas.js'
import {
  applyTerminalKeystrokes,
  getTerminalManager,
  refreshTerminalTaskPreview,
  TerminalTool,
  resetTerminalManagerForTesting,
  terminalTaskRegistry,
} from './TerminalTool.js'

test('Terminal is discoverable without loading its schema eagerly', () => {
  assert.equal(isDeferredTool(TerminalTool), true)
  assert.deepEqual(formatDeferredToolLines([TerminalTool]), ['Terminal'])
  assert.match(TerminalTool.searchHint ?? '', /terminal/i)
})

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

function createContext(
  overrides: Partial<ToolUseContext> = {},
): ToolUseContext {
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
    ...overrides,
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
  resetCommandQueue()
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

test('getTerminalManager registers one shutdown cleanup that closes every pane', async () => {
  resetTerminalManagerForTesting()
  const manager = getTerminalManager()
  assert.equal(getTerminalManager(), manager)
  let closeAllCalls = 0
  manager.closeAll = () => {
    closeAllCalls++
  }

  await runCleanupFunctions()

  assert.equal(closeAllCalls, 1)
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

test('uses the shared task state setter and routes subagent notifications', async () => {
  let rootState: TestAppState = {
    toolPermissionContext: { mode: 'default' } as AppState['toolPermissionContext'],
    tasks: {},
  }
  const agentId = 'a1234567890abcdef' as ToolUseContext['agentId']
  const context = createContext({
    agentId,
    setAppState: _updater => {},
    setAppStateForTasks: updater => {
      rootState = updater(rootState as AppState) as TestAppState
    },
    getAppState: () => rootState as AppState,
  })
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver })
  resetTerminalManagerForTesting(manager)
  const opened = await TerminalTool.call(
    { action: 'new-session', cwd: process.cwd(), cols: 80, rows: 24 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const target = String((opened.data as { target: string }).target)
  driver.finishNaturally(target, 'subagent output', 0)

  await refreshTerminalTaskPreview(
    target,
    context.setAppStateForTasks!,
    manager,
  )

  const task = Object.values(rootState.tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.agentId, agentId)
  assert.equal(task?.status, 'completed')
  assert.equal(
    getCommandQueue().find(command => command.mode === 'task-notification')?.agentId,
    agentId,
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

  const resolved = resolveTerminalCommand()
  assert.equal(task?.command, resolved.command)
  assert.deepEqual(task?.args, resolved.args)

  await TerminalTool.call(
    { action: 'kill-pane', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
})

test('call does not ask again after the pipeline approved the action', async () => {
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
    { action: 'kill-pane', target },
    createContext(),
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  assert.deepEqual(permissionCalls, [])
})

function createPermissionContext(
  permission: Partial<AppState['toolPermissionContext']>,
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      ...permission,
    },
    tasks: {},
  }
  return createContext({ getAppState: () => appState as AppState })
}

async function checkTerminal(
  input: Record<string, unknown>,
  permission: Partial<AppState['toolPermissionContext']>,
) {
  return hasPermissionsToUseTool(
    TerminalTool,
    input,
    createPermissionContext(permission),
    TEST_ASSISTANT_MESSAGE,
    'terminal-permission-test',
  )
}

const TOUCH_KEYS = {
  action: 'send-keys' as const,
  target: 'sess-1',
  text: 'touch x',
  enter: true,
}

test('default mode asks before new-session and before send-keys runs a command', async () => {
  assert.equal(
    (await checkTerminal({ action: 'new-session' }, { mode: 'default' })).behavior,
    'ask',
  )
  assert.equal(
    (await checkTerminal({ action: 'new-session', command: 'touch', args: ['x'] }, { mode: 'default' })).behavior,
    'ask',
  )
  assert.equal((await checkTerminal(TOUCH_KEYS, { mode: 'default' })).behavior, 'ask')
})

test('Bash deny rules apply to commands sent through Terminal', async () => {
  const prefixDeny = { alwaysDenyRules: { session: ['Bash(touch:*)'] } }
  assert.equal((await checkTerminal(TOUCH_KEYS, prefixDeny)).behavior, 'deny')
  assert.equal(
    (await checkTerminal({ action: 'new-session', command: 'touch', args: ['x'] }, prefixDeny)).behavior,
    'deny',
  )
  assert.equal(
    (await checkTerminal(TOUCH_KEYS, { mode: 'bypassPermissions', ...prefixDeny })).behavior,
    'deny',
  )
  assert.equal(
    (await checkTerminal({ ...TOUCH_KEYS, text: 'ls' }, { alwaysDenyRules: { session: ['Bash'] } })).behavior,
    'deny',
  )
  assert.equal(
    (await checkTerminal({ action: 'list-panes' }, { alwaysDenyRules: { session: ['Terminal'] } })).behavior,
    'deny',
  )
})

test('dontAsk denies Terminal commands instead of running them', async () => {
  assert.equal((await checkTerminal(TOUCH_KEYS, { mode: 'dontAsk' })).behavior, 'deny')
})

test('bypassPermissions allows Terminal commands', async () => {
  const result = await checkTerminal(TOUCH_KEYS, { mode: 'bypassPermissions' })
  assert.equal(result.behavior, 'allow')
  assert.deepEqual(result.behavior === 'allow' && result.updatedInput, TOUCH_KEYS)
})

test('read-only and session-control Terminal actions do not ask', async () => {
  for (const input of [
    { action: 'list-panes' },
    { action: 'capture-pane', target: 'sess-1' },
    { action: 'display-message', target: 'sess-1' },
    { action: 'resize-pane', target: 'sess-1', cols: 80, rows: 24 },
    { action: 'send-signal', target: 'sess-1', signal: 'SIGINT' },
    { action: 'kill-pane', target: 'sess-1' },
    { action: 'send-keys', target: 'sess-1', key: 'ENTER' },
  ]) {
    assert.equal((await checkTerminal(input, { mode: 'default' })).behavior, 'allow', input.action)
  }
})

test('send-keys auto classifier input is the submitted command line', () => {
  assert.equal(
    TerminalTool.toAutoClassifierInput(TOUCH_KEYS),
    'send-keys sess-1 command="touch x"',
  )
})

test('applyTerminalKeystrokes replays line editing keys', () => {
  assert.deepEqual(applyTerminalKeystrokes('tou', 'ch x\r'), { line: '', submitted: ['touch x'] })
  assert.deepEqual(applyTerminalKeystrokes('rm -rf /', '\x15ls'), { line: 'ls', submitted: [] })
  assert.deepEqual(applyTerminalKeystrokes('rm', '\x03'), { line: '', submitted: [] })
  assert.deepEqual(applyTerminalKeystrokes('lsx', '\x7f\x1b[A\r'), { line: '', submitted: ['ls'] })
  assert.deepEqual(applyTerminalKeystrokes('', 'a\nb'), { line: 'b', submitted: ['a'] })
})

async function openPermissionSession(permission: Partial<AppState['toolPermissionContext']>) {
  const context = createPermissionContext(permission)
  const opened = await TerminalTool.call(
    { action: 'new-session', cols: 80, rows: 24 },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const target = String((opened.data as { target: string }).target)
  // Runs send-keys only when the permission pipeline allows it, like tool execution.
  const send = async (keys: Record<string, unknown>) => {
    const input = { action: 'send-keys' as const, target, ...keys }
    const decision = await hasPermissionsToUseTool(
      TerminalTool, input, context, TEST_ASSISTANT_MESSAGE, 'terminal-send-keys-test',
    )
    if (decision.behavior === 'allow') {
      await TerminalTool.call(input, context, allowPermission, TEST_ASSISTANT_MESSAGE)
    }
    return decision.behavior
  }
  return { target, send }
}

test('send-keys checks the accumulated line, so a split command still hits deny rules', async () => {
  const deny = { alwaysDenyRules: { session: ['Bash(touch:*)'] } }
  const typedLater = await openPermissionSession(deny)
  assert.equal(await typedLater.send({ text: 'tou' }), 'allow')
  assert.equal(await typedLater.send({ text: 'ch x' }), 'deny')
  assert.equal(await typedLater.send({ text: 'ch x', enter: true }), 'deny')

  const bypass = await openPermissionSession({ mode: 'bypassPermissions', ...deny })
  assert.equal(await bypass.send({ text: 'tou' }), 'allow')
  assert.equal(await bypass.send({ text: 'ch x', enter: true }), 'deny')
})

test('typing a line is not a command until Enter submits it', async () => {
  const session = await openPermissionSession({ mode: 'default' })
  assert.equal(await session.send({ text: 'tou' }), 'allow')
  assert.equal(await session.send({ text: 'ch x' }), 'allow')
  assert.equal(
    TerminalTool.toAutoClassifierInput({ action: 'send-keys', target: session.target, enter: true }),
    `send-keys ${session.target} command="touch x"`,
  )
  assert.equal(await session.send({ key: 'ENTER' }), 'ask')
  assert.equal(await session.send({ text: 'touch x', enter: true }), 'ask')
})

test('control keys do not trigger a check and Ctrl-C clears the pending line', async () => {
  const session = await openPermissionSession({ mode: 'default' })
  assert.equal(await session.send({ text: 'touch x' }), 'allow')
  assert.equal(await session.send({ key: 'CTRL_C' }), 'allow')
  assert.equal(await session.send({ text: 'ls', enter: true }), 'allow')

  const denied = await openPermissionSession({ alwaysDenyRules: { session: ['Bash'] } })
  for (const key of ['UP', 'ESC', 'TAB', 'CTRL_C', 'CTRL_L', 'ENTER']) {
    assert.equal(await denied.send({ key }), 'allow', key)
  }
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

test('polls naturally exited panes and enqueues exactly one completion notification', async () => {
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

  await new Promise(resolve => setTimeout(resolve, 1_100))

  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.preview, 'TERMINAL_L5_OK')
  assert.equal(task?.closed, true)
  assert.equal(task?.status, 'completed')
  assert.equal(task?.exitCode, 0)
  assert.equal(task?.notified, true)
  assert.equal(terminalTaskRegistry.has(target), false)
  assert.equal(readFileSync(task!.outputFile, 'utf8'), 'TERMINAL_L5_OK')

  const notifications = getCommandQueue().filter(
    command => command.mode === 'task-notification',
  )
  assert.equal(notifications.length, 1)
  assert.match(String(notifications[0]?.value), /<status>completed<\/status>/)
  assert.match(String(notifications[0]?.value), new RegExp(`<task-id>${task?.id}<\\/task-id>`))

  await new Promise(resolve => setTimeout(resolve, 1_100))
  assert.equal(
    getCommandQueue().filter(command => command.mode === 'task-notification').length,
    1,
  )
})

test('marks non-zero natural exits as failed', async () => {
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver })
  resetTerminalManagerForTesting(manager)
  const context = createContext()
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      command: '/bin/sh',
      args: ['-c', 'printf TERMINAL_FAIL; exit 7'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  const target = String((opened.data as { target: string }).target)
  driver.finishNaturally(target, 'TERMINAL_FAIL', 7)

  await refreshTerminalTaskPreview(target, context.setAppState, manager)

  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.status, 'failed')
  assert.equal(task?.exitCode, 7)
  assert.equal(task?.notified, true)
  assert.equal(readFileSync(task!.outputFile, 'utf8'), 'TERMINAL_FAIL')
  assert.match(
    String(getCommandQueue().find(command => command.mode === 'task-notification')?.value),
    /<status>failed<\/status>/,
  )
})

test('refreshes a naturally exited pane through the shared detail path', async () => {
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver })
  resetTerminalManagerForTesting(manager)
  const context = createContext()
  const opened = await TerminalTool.call(
    {
      action: 'new-session',
      command: '/bin/sh',
      args: ['-c', 'printf TERMINAL_DETAIL_OK'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  const target = String((opened.data as { target: string }).target)
  driver.finishNaturally(target, 'TERMINAL_DETAIL_OK', 0)
  await refreshTerminalTaskPreview(target, context.setAppState, manager)

  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.preview, 'TERMINAL_DETAIL_OK')
  assert.equal(task?.closed, true)
  assert.equal(task?.status, 'completed')
  assert.equal(task?.notified, true)
  assert.equal(terminalTaskRegistry.has(target), false)
  assert.equal(
    getCommandQueue().filter(command => command.mode === 'task-notification').length,
    1,
  )
})

test('preserves send-signal termination while the process exits asynchronously', async () => {
  const driver = new FakePtyDriver()
  driver.kill = driver.signalAsynchronously.bind(driver)
  const manager = new PtySessionManager({ driver })
  resetTerminalManagerForTesting(manager)
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
  const signaled = await TerminalTool.call(
    { action: 'send-signal', target, signal: 'SIGINT' },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((signaled.data as { accepted: boolean }).accepted, true)
  assert.equal((signaled.data as { isRunning: boolean }).isRunning, true)

  driver.finishSignal(target)
  await refreshTerminalTaskPreview(target, context.setAppState, manager)

  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.status, 'killed')
  assert.equal(task?.signal, 'SIGINT')
  assert.equal(task?.notified, true)
  assert.match(
    String(getCommandQueue().find(command => command.mode === 'task-notification')?.value),
    /<status>killed<\/status>/,
  )
})

test('does not treat a later natural exit as killed when a signal was ignored', async () => {
  const driver = new FakePtyDriver()
  driver.kill = driver.signalAsynchronously.bind(driver)
  const manager = new PtySessionManager({ driver })
  resetTerminalManagerForTesting(manager)
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
  await TerminalTool.call(
    { action: 'send-signal', target, signal: 'SIGINT' },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )

  driver.finishNaturally(target, 'continued', 0)
  await refreshTerminalTaskPreview(target, context.setAppState, manager)

  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.status, 'completed')
  assert.equal(task?.signal, null)
  assert.equal(task?.terminationReason, undefined)
})

test('preserves send-signal semantics by closing and killing the task', async () => {
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
  const signaled = await TerminalTool.call(
    { action: 'send-signal', target, signal: 'SIGINT' },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((signaled.data as { accepted: boolean }).accepted, true)

  const status = await TerminalTool.call(
    { action: 'display-message', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((status.data as { isRunning: boolean }).isRunning, false)
  assert.equal((status.data as { exitCode: number | null }).exitCode, 130)
  assert.equal(terminalTaskRegistry.has(target), false)
  const task = Object.values(context.getAppState().tasks).find(
    (value): value is TerminalTask =>
      value.type === 'interactive_terminal' && value.sessionId === target,
  )
  assert.equal(task?.status, 'killed')
  assert.equal(task?.signal, 'SIGINT')
  assert.match(
    String(getCommandQueue().find(command => command.mode === 'task-notification')?.value),
    /<status>killed<\/status>/,
  )

  const closed = await TerminalTool.call(
    { action: 'kill-pane', target },
    context,
    allowPermission,
    TEST_ASSISTANT_MESSAGE,
  )
  assert.equal((closed.data as { closed: boolean }).closed, true)
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

test('new-session runs inside the sandbox when sandboxing is enabled', async () => {
  const opens: PtyDriverOpenOptions[] = []
  const driver = new FakePtyDriver()
  const open = driver.open.bind(driver)
  driver.open = options => {
    opens.push(options)
    return open(options)
  }
  resetTerminalManagerForTesting(new PtySessionManager({ driver }))
  const wraps: string[] = []
  mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
  mock.method(SandboxManager, 'areUnsandboxedCommandsAllowed', () => true)
  mock.method(SandboxManager, 'wrapWithSandbox', async (command: string) => {
    wraps.push(command)
    return `SANDBOXED ${command}`
  })
  const cleanup = mock.method(SandboxManager, 'cleanupAfterCommand', () => {})
  try {
    const shell = resolveTerminalCommand({ command: 'sh' }).command
    const result = await TerminalTool.call(
      { action: 'new-session', command: 'sh', args: ['-i'], cwd: process.cwd() },
      createContext(),
      allowPermission,
      TEST_ASSISTANT_MESSAGE,
    )
    const data = result.data as { target: string; command: string; args: string[]; sandboxed?: boolean }
    assert.equal(data.sandboxed, true)
    assert.equal(data.command, shell)
    assert.deepEqual(data.args, ['-i'])
    assert.equal(wraps.length, 1)
    assert.match(wraps[0]!, new RegExp(`${shell} -i`))
    assert.equal(opens[0]?.command, '/bin/sh')
    assert.deepEqual(opens[0]?.args, ['-c', `SANDBOXED ${wraps[0]}`])

    await TerminalTool.call(
      { action: 'kill-pane', target: data.target },
      createContext(),
      allowPermission,
      TEST_ASSISTANT_MESSAGE,
    )
    assert.equal(cleanup.mock.callCount(), 1)

    const outside = await TerminalTool.call(
      { action: 'new-session', command: 'sh', cwd: process.cwd(), dangerouslyDisableSandbox: true },
      createContext(),
      allowPermission,
      TEST_ASSISTANT_MESSAGE,
    )
    assert.equal((outside.data as { sandboxed?: boolean }).sandboxed, undefined)
    assert.equal(wraps.length, 1)
    assert.equal(opens[1]?.command, shell)
  } finally {
    mock.restoreAll()
  }
})
