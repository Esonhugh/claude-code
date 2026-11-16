import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { buildTool, getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { enqueue, getCommandQueueSnapshot, POLL_EVENT_CHUNK_EVENTS, resetCommandQueue } from '../../utils/messageQueueManager.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { NO_PENDING_EVENTS } from '../PollTool/prompt.js'
import { PollTool, setPollWaitForTesting } from '../PollTool/PollTool.js'
import { isCodeModeEnabled, noteReplLaunchPermissionMode, resetCodeModeGateForTesting } from './codeModeGate.js'
import { getReplPrompt } from './prompt.js'
import { REPL_ASYNC_WALL_CAP_MS, REPL_MAX_PENDING_EVALS, REPLTool, setReplAsyncTimingForTesting } from './REPLTool.js'
import {
  abortPendingReplEvals,
  findReplSession,
  formatReplEvalEvent,
  getReplSession,
  releaseAllReplSessions,
  replLedger,
} from './sessions.js'

const savedCodeMode = process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const savedInteractive = getIsInteractive()
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
const originalSettings = getSessionSettingsCache()
beforeAll(() => {
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
    setCachedSettingsForSource(source, {})
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  resetCodeModeGateForTesting()
})
afterAll(() => {
  releaseAllReplSessions()
  setReplAsyncTimingForTesting()
  setPollWaitForTesting()
  restore('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', savedCodeMode)
  restore('CLAUDE_CODE_ENTRYPOINT', savedEntrypoint)
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})
afterEach(() => {
  releaseAllReplSessions()
  resetCommandQueue()
  setReplAsyncTimingForTesting({ settleMs: 100 })
  setPollWaitForTesting()
})

const allow: CanUseToolFn = async () => ({ behavior: 'allow' })

const fakeRead = buildTool({
  name: 'Read',
  inputSchema: z.object({ file_path: z.string() }),
  maxResultSizeChars: Infinity,
  isConcurrencySafe: () => true,
  description: async () => 'Read fake',
  prompt: async () => 'Read fake prompt',
  renderToolUseMessage: () => null,
  call: async (input: { file_path: string }) => {
    // A path like `slow:150` takes that many ms to read.
    const ms = /^slow:(\d+)$/.exec(input.file_path)?.[1]
    if (ms) await new Promise(r => setTimeout(r, Number(ms)))
    return { data: `contents of ${input.file_path}` }
  },
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: String(data) }),
} as Parameters<typeof buildTool>[0]) as Tool

let nextAgent = 0
function contextFor(mode: PermissionMode = 'bypassPermissions') {
  const permissions = { ...getEmptyToolPermissionContext(), mode }
  return {
    options: { tools: [REPLTool, PollTool, fakeRead], mcpClients: [], isNonInteractiveSession: true, spawnDepth: 1 },
    abortController: new AbortController(),
    messages: [],
    agentId: `lane-${nextAgent++}`,
    toolUseId: 'toolu_current',
    getAppState: () => ({ toolPermissionContext: permissions, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    // As the streaming executor sets it for a REPL call (official `qu` reads only its presence).
    stoppedResultWait: () => undefined,
  } as unknown as ToolUseContext
}

/** Each test context is a subagent the main thread spawned (official `lAt`), so it gets the async lane. */
function asAgent<T>(context: ToolUseContext, fn: () => T): T {
  return runWithAgentContext({ agentId: context.agentId!, agentType: 'subagent', subagentName: 'general-purpose' }, fn)
}

async function run(code: string, context: ToolUseContext, o: { timeout?: number; onProgress?: (p: unknown) => void } = {}) {
  const result = await asAgent(context, () => REPLTool.call(
    { code, ...(o.timeout === undefined ? {} : { timeout: o.timeout }) },
    context,
    allow,
    undefined as never,
    o.onProgress as never,
  ))
  return { ...result, text: REPLTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_current').content as string }
}

async function poll(context: ToolUseContext) {
  const result = await asAgent(context, () => PollTool.call({}, context))
  return { ...result, text: PollTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_poll').content as string }
}

const sleepCode = (ms: number, value: string) => `await new Promise(r => setTimeout(r, ${ms})); ${JSON.stringify(value)}`

setReplAsyncTimingForTesting({ settleMs: 100 })

test('Code Mode is on for these tests', () => {
  expect(isCodeModeEnabled()).toBe(true)
})

describe('REPL async lane', () => {
  test('a script past the settle window returns a receipt, and Poll delivers its outcome once', async () => {
    const context = contextFor()
    const receipt = await run(sleepCode(400, 'done'), context)
    expect(receipt.text).toBe('(dispatched #1)')
    expect(receipt.data).toMatchObject({ asyncDispatched: true, evalId: 1 })
    const polled = await poll(context)
    expect(polled.data.eventCount).toBe(1)
    expect(polled.text).toMatch(/^<event kind="repl-eval" at="[^"]+" eval="1" ms="\d+" status="settled">\n<result>done<\/result>\n<\/event>$/)
    // Taken out of the notification queue, so the next turn doesn't get it again.
    expect(getCommandQueueSnapshot()).toHaveLength(0)
    expect((await poll(context)).text).toBe(NO_PENDING_EVENTS)
  })

  test('without Poll the outcome is queued as a notification for the next turn', async () => {
    const context = contextFor('auto')
    expect((await run(sleepCode(300, 'later'), context)).text).toBe('(dispatched #1)')
    await new Promise(r => setTimeout(r, 500))
    const queued = getCommandQueueSnapshot()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ mode: 'task-notification', agentId: context.agentId })
    expect(String(queued[0]!.value)).toContain('<result>later</result>')
  })

  test('a script that finishes in the window answers directly, numbered', async () => {
    const context = contextFor()
    const { text, data } = await run('1 + 1', context)
    expect(text).toBe('<repl-output eval="1">\n<result>2</result>\n</repl-output>')
    expect(data.asyncDispatched).toBeUndefined()
    const session = findReplSession(context.agentId!)!
    expect([session.ledger.size, session.depth, session.undelivered.size]).toEqual([0, 0, 0])
  })

  test('the ledger holds a dispatched script as detached until its outcome is delivered', async () => {
    const context = contextFor()
    await run(sleepCode(400, 'done'), context)
    const session = findReplSession(context.agentId!)!
    // The executor's detach timer starts a tick after the settle window's.
    await new Promise(r => setTimeout(r, 20))
    expect(replLedger(session).map(row => [row.id, row.state])).toEqual([[1, 'detached']])
    expect(session.depth).toBe(1)
    await poll(context)
    expect([session.ledger.size, session.depth, session.undelivered.size]).toEqual([0, 0, 0])
  })

  test('a second script runs while one is pending and shares its variables', async () => {
    const context = contextFor()
    await run(`shared = 'first'; ${sleepCode(500, 'slow')}`, context)
    const second = await run('shared', context)
    expect(second.text).toContain('eval="2"')
    expect(second.text).toContain('<result>first</result>')
    expect((await poll(context)).text).toContain('<result>slow</result>')
  })

  test('a failed background script comes back as an error event and a virtual REPL pair', async () => {
    const context = contextFor()
    await run(`await new Promise(r => setTimeout(r, 300)); throw new Error('boom')`, context)
    const polled = await poll(context)
    expect(polled.text).toContain('<error>Error: boom</error>')
    const messages = ((polled as { newMessages?: unknown }).newMessages ?? []) as {
      type: string
      isVirtual?: boolean
      message: { content: { type: string; id?: string; name?: string; content?: string }[] }
    }[]
    expect(messages.map(m => [m.type, m.isVirtual])).toEqual([
      ['assistant', true],
      ['user', true],
    ])
    const use = messages[0]!.message.content[0]!
    expect(use).toMatchObject({ type: 'tool_use', name: 'REPL' })
    expect(use.id).toMatch(/^repl_eval_/)
    expect(messages[1]!.message.content[0]!.content).toContain('<repl-output eval="1">')
  })
})

describe('REPL async lane limits', () => {
  test(`at most ${REPL_MAX_PENDING_EVALS} dispatched scripts per context`, async () => {
    setReplAsyncTimingForTesting({ settleMs: 30 })
    const context = contextFor()
    for (let i = 1; i <= REPL_MAX_PENDING_EVALS; i++)
      expect((await run(sleepCode(20_000, 'x'), context, { timeout: 60_000 })).text).toBe(`(dispatched #${i})`)
    const refused = await run('1', context)
    expect(refused.data.error).toBe(
      `async REPL dispatch rejected: ${REPL_MAX_PENDING_EVALS} evals already waiting or running \u2014 wait for their settles (Poll) before dispatching more`,
    )
    expect(refused.data.asyncDispatched).toBe(true)
    expect(findReplSession(context.agentId!)?.pending.size).toBe(REPL_MAX_PENDING_EVALS)
  })

  test('the wall-clock cap stops a dispatched script', async () => {
    setReplAsyncTimingForTesting({ settleMs: 50, wallCapMs: 300 })
    const context = contextFor()
    expect((await run(sleepCode(5_000, 'never'), context, { timeout: 60_000 })).text).toBe('(dispatched #1)')
    const polled = await poll(context)
    expect(polled.text).toContain('hard wall-clock limit of 300ms')
  })

  test('Esc and backgrounding the turn stop dispatched scripts; a turn abort keeps them', async () => {
    const escContext = contextFor()
    await run(sleepCode(5_000, 'never'), escContext, { timeout: 60_000 })
    escContext.abortController.abort('user-cancel')
    const stopped = await poll(contextAfterAbort(escContext))
    // Official `qu`: a "user-cancel" stop gets the user-stop report, not `Ju()`.
    expect(stopped.text).toContain('<error>The user interrupted this script, so it stopped. STOP what you are doing')

    const bgContext = contextFor()
    await run(sleepCode(5_000, 'never'), bgContext, { timeout: 60_000 })
    bgContext.abortController.abort('background')
    expect((await poll(contextAfterAbort(bgContext))).text).toContain('<error>Error: REPL execution interrupted</error>')

    const turnContext = contextFor()
    await run(sleepCode(400, 'kept'), turnContext)
    turnContext.abortController.abort('turn-abort')
    expect((await poll(contextAfterAbort(turnContext))).text).toContain('<result>kept</result>')
  })

  test('a stopped dispatched script passes the abort reason to its inner calls', async () => {
    const reasons: unknown[] = []
    const waiter = buildTool({
      ...(fakeRead as object),
      name: 'Waiter',
      inputSchema: z.object({}),
      call: (_input: unknown, inner: ToolUseContext) =>
        new Promise(resolve => {
          inner.abortController.signal.addEventListener('abort', () => {
            reasons.push(inner.abortController.signal.reason)
            resolve({ data: 'stopped' })
          })
        }),
    } as unknown as Parameters<typeof buildTool>[0]) as Tool
    const between = contextFor()
    ;(between.options as unknown as { tools: Tool[] }).tools = [REPLTool, PollTool, waiter]
    expect((await run('await Waiter({})', between)).text).toBe('(dispatched #1)')
    // Esc between turns (official `kge.abort` stops the eval with "user-cancel").
    abortPendingReplEvals(findReplSession(between.agentId!)!, 'user-cancel')
    await poll(contextAfterAbort(between))

    const interrupted = contextFor()
    ;(interrupted.options as unknown as { tools: Tool[] }).tools = [REPLTool, PollTool, waiter]
    expect((await run('await Waiter({})', interrupted)).text).toBe('(dispatched #1)')
    interrupted.abortController.abort('background')
    await poll(contextAfterAbort(interrupted))
    expect(reasons).toEqual(['user-cancel', 'background'])
  })

  test('a dispatched script the user stops lists the tool calls it started', async () => {
    const waiter = buildTool({
      ...(fakeRead as object),
      name: 'Waiter',
      inputSchema: z.object({}),
      call: (_input: unknown, inner: ToolUseContext) =>
        new Promise(resolve => inner.abortController.signal.addEventListener('abort', () => resolve({ data: 'stopped' }))),
    } as unknown as Parameters<typeof buildTool>[0]) as Tool
    const context = contextFor()
    ;(context.options as unknown as { tools: Tool[] }).tools = [REPLTool, PollTool, fakeRead, waiter]
    expect((await run(`await Read({file_path: 'a'}); await Waiter({})`, context)).text).toBe('(dispatched #1)')
    abortPendingReplEvals(findReplSession(context.agentId!)!, 'user-cancel')
    const { text } = await poll(contextAfterAbort(context))
    expect(text).toContain(
      [
        '<error>The user interrupted this script, so it stopped. STOP what you are doing and wait for the user to tell you how to proceed.',
        'Tool calls the script started, in order:',
        '1. Read({"file_path":"a"}) finished. It returned:',
        '  contents of a',
        '2. Waiter({}) was still running when the script stopped. The script got no result, and the call may have run in part or in full.',
        'That is every tool call the script started.</error>',
      ].join('\n'),
    )
  })

  test('a user stop outside the executor wait gets the plain interrupted error', async () => {
    const context = { ...contextFor(), stoppedResultWait: undefined } as ToolUseContext
    expect((await run(`await new Promise(() => {})`, context)).text).toBe('(dispatched #1)')
    abortPendingReplEvals(findReplSession(context.agentId!)!, 'user-cancel')
    const { text } = await poll(contextAfterAbort(context))
    expect(text).toContain('<error>Error: REPL execution interrupted</error>')
  })

  test('a Poll wait with nothing to deliver ends in a status line', async () => {
    setPollWaitForTesting(150)
    const context = contextFor()
    await run(sleepCode(5_000, 'never'), context, { timeout: 60_000 })
    const polled = await poll(context)
    expect(polled.data).toMatchObject({ eventCount: 1, remainingWakeCount: 0 })
    expect(polled.text).toMatch(
      /^<event kind="repl-status" at="[^"]+" pending="1">no output yet \u2014 1 eval pending: #1 running for \d+s \(detached: later evals run beside it\)\. Poll again to keep waiting\.<\/event>$/,
    )
  })

  test('Poll with no context, or nothing running, returns at once', async () => {
    const context = contextFor()
    expect((await poll(context)).text).toBe(NO_PENDING_EVENTS)
    await run('1', context)
    expect((await poll(context)).text).toBe(NO_PENDING_EVENTS)
  })

  test('a message from the user ends a Poll wait', async () => {
    const context = contextFor()
    await run(sleepCode(5_000, 'never'), context, { timeout: 60_000 })
    const waiting = poll(context)
    setTimeout(() => enqueue({ value: 'hi', mode: 'prompt', agentId: context.agentId as never }), 50)
    const started = Date.now()
    expect((await waiting).text).toBe(NO_PENDING_EVENTS)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('progress from inner calls stops once the script is dispatched', async () => {
    const context = contextFor()
    const progress: unknown[] = []
    await run(
      `await Read({file_path: 'a'}); await new Promise(r => setTimeout(r, 300)); await Read({file_path: 'b'}); 'ok'`,
      context,
      { onProgress: p => progress.push(p) },
    )
    const before = progress.length
    expect(before).toBeGreaterThan(0)
    expect((await poll(context)).text).toContain('<result>ok</result>')
    expect(progress).toHaveLength(before)
  })

  test('run_in_background is refused for inner shell calls', async () => {
    const context = contextFor()
    const bash = buildTool({
      ...(fakeRead as object),
      name: 'Bash',
      inputSchema: z.object({ command: z.string(), run_in_background: z.boolean().optional() }),
    } as Parameters<typeof buildTool>[0]) as Tool
    ;(context.options as unknown as { tools: Tool[] }).tools = [REPLTool, PollTool, bash]
    const { text } = await run(`await Bash({command: 'ls', run_in_background: true})`, context)
    expect(text).toContain('run_in_background is not available in the async REPL')
  })

  test('inner shell timeouts default to the shell max and cap at the async wall cap', async () => {
    const context = contextFor()
    const seen: unknown[] = []
    const bash = buildTool({
      ...(fakeRead as object),
      name: 'Bash',
      inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
      validateInput: async (_input: unknown, inner: { shellWallCapMs?: number }) => {
        caps.push(inner.shellWallCapMs)
        return { result: true }
      },
      call: async (input: { timeout?: number }) => {
        seen.push(input.timeout)
        return { data: 'ok' }
      },
    } as unknown as Parameters<typeof buildTool>[0]) as Tool
    const caps: unknown[] = []
    ;(context.options as unknown as { tools: Tool[] }).tools = [REPLTool, PollTool, bash]
    await run(`await Bash({command: 'a'}); await Bash({command: 'b', timeout: 9e6}); await Bash({command: 'c', timeout: 5})`, context)
    expect(seen).toEqual([600_000, REPL_ASYNC_WALL_CAP_MS, 5])
    // Official passes shellWallCapMs to the inner call's validateInput (it lifts the leading-sleep block).
    expect(caps).toEqual([REPL_ASYNC_WALL_CAP_MS, REPL_ASYNC_WALL_CAP_MS, REPL_ASYNC_WALL_CAP_MS])
  })

  test('Poll refuses an agent without the async lane', async () => {
    const nested = contextFor()
    ;(nested.options as unknown as { spawnDepth: number }).spawnDepth = 2
    await expect(poll(nested)).rejects.toThrow(
      "Poll isn't available here and isn't needed: each REPL call you make here waits for its script to finish and returns the result.",
    )
    const nestedRun = await run(sleepCode(200, 'waited'), nested)
    expect(nestedRun.data.asyncDispatched).toBeUndefined()
  })

  test('a second Poll while one waits returns at once', async () => {
    const context = contextFor()
    await run(sleepCode(5_000, 'never'), context, { timeout: 60_000 })
    setPollWaitForTesting(300)
    const first = poll(context)
    const second = await poll(context)
    expect(second.data).toEqual({ content: NO_PENDING_EVENTS, eventCount: 0, remainingWakeCount: 0 })
    expect((await first).data.eventCount).toBe(1)
  })

  test('Poll delivers at most 20 events at a time and says how many follow', async () => {
    const context = contextFor()
    const session = getReplSession(context.agentId!)
    for (let id = 1; id <= POLL_EVENT_CHUNK_EVENTS + 3; id++) session.events.push({ id, text: `e${id}`, queued: false })
    const first = await poll(context)
    expect(first.data).toMatchObject({ eventCount: POLL_EVENT_CHUNK_EVENTS, remainingWakeCount: 3 })
    expect(first.text.endsWith(
      '<system>delivery chunked: 3 more queued event(s) follow in the next delivery, oldest first; nothing was dropped.</system>',
    )).toBe(true)
    const rest = await poll(context)
    expect(rest.data).toEqual({ content: 'e21\ne22\ne23', eventCount: 3, remainingWakeCount: 0 })
  })

  test('a host-side failure is an escaped failed event', () => {
    const at = new Date('2026-01-01T00:00:00.000Z')
    expect(formatReplEvalEvent(4, 12.4, 'worker <gone>', at, 'failed')).toBe(
      '<event kind="repl-eval" at="2026-01-01T00:00:00.000Z" eval="4" ms="12" status="failed">eval #4 FAILED before settling:\nworker &lt;gone&gt;</event>',
    )
  })
})

describe('outside the async lane', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk'] as PermissionMode[])
    test(`${mode} mode waits for the script and never dispatches`, async () => {
      setReplAsyncTimingForTesting({ settleMs: 30 })
      const context = contextFor(mode)
      const { text, data } = await run(sleepCode(200, 'waited'), context)
      expect(text).toBe('<repl-output>\n<result>waited</result>\n</repl-output>')
      expect(data.asyncDispatched).toBeUndefined()
    })
})

describe('calls left running at script end', () => {
  const savedConcurrency = process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
  afterEach(() => restore('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY', savedConcurrency))

  test('the async lane says they run on', async () => {
    const { text } = await run(`Read({file_path: 'slow:150'}); 'ok'`, contextFor('bypassPermissions'))
    expect(text).toBe(
      "<repl-output eval=\"1\">\n<log>[stderr] \u26a0 1 tool call(s) still running at script end (Read) \u2014 they run on and their effects happen; what a .then(self.log) logs arrives as late output, anything else is not in this result. Do not re-issue them; await next time.</log>\n<result>ok</result>\n</repl-output>",
    )
  })

  test('the sync lane waits for a running call and does not start one still queued', async () => {
    process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '1'
    const context = contextFor('default')
    const startedAt = Date.now()
    const { text } = await run(`Read({file_path: 'slow:150'}); Read({file_path: 'queued'}); 'ok'`, context)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    expect(text).toBe(
      "<repl-output>\n<log>[stderr] \u26a0 1 tool call(s) had not started when the script ended, and did not run: Read. Add 'await'.\n\u26a0 1 tool call(s) were still running when the script ended. They ran to their end, but the script ended before their results came: Read. Do not make them again. Add 'await' next time.</log>\n<result>ok</result>\n</repl-output>",
    )
  })

  test('the sync lane refuses a call made after the script ended', async () => {
    const context = contextFor('default')
    // The chain's call comes after the script's end, while the end waits for the running Read.
    await run(
      `Read({file_path: 'slow:150'}); globalThis.later = (async () => { for (let i = 0; i < 1000; i++) await null; return Read({file_path: 'x'}) })(); 'ok'`,
      context,
    )
    expect((await run('await later', context)).text).toContain(
      "This tool call did not run. The piece of code that it belongs to had already finished, and a timer or promise that finished code leaves running can't make tool calls.",
    )
  })
})

describe('async-lane prompt', () => {
  const fakeBash = buildTool({
    name: 'Bash',
    inputSchema: z.object({ command: z.string(), run_in_background: z.boolean().optional() }),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    description: async () => 'Bash fake',
    prompt: async () => 'Bash fake prompt',
    renderToolUseMessage: () => null,
    call: async () => ({ data: '' }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: String(data) }),
  } as Parameters<typeof buildTool>[0]) as Tool
  const promptFor = (mode: PermissionMode) =>
    getReplPrompt([REPLTool, PollTool, fakeRead, fakeBash], { ...getEmptyToolPermissionContext(), mode })
  afterAll(() => resetCodeModeGateForTesting())

  test('a session launched in auto or bypassPermissions gets the async text and the mode-change note, in every mode', () => {
    resetCodeModeGateForTesting()
    noteReplLaunchPermissionMode('auto')
    for (const mode of ['default', 'bypassPermissions'] as PermissionMode[]) {
      const prompt = promptFor(mode)
      expect(prompt).toContain('Your two tools are `REPL` and `Poll`; there are no other tools.')
      expect(prompt).toContain('returns `(dispatched #N)` instead, runs on, and no longer holds up the scripts after it')
      expect(prompt).toContain('in a `Poll` result or before your next turn')
      expect(prompt).toContain('The user can change the permission mode at any time.')
      expect(prompt).not.toContain("A call's result is a `<repl-output>` element")
      expect(prompt).toContain('A command with no timeout of its own is awaited for up to 600000 ms; give it a longer one (at most 7200000 ms)')
      expect(prompt).not.toContain('Timeouts cap at 600000 ms')
      // Official Vl: with Poll in the list, interface Tools drops run_in_background from the shell tools.
      expect(prompt).toContain('Bash(input: {')
      expect(prompt).not.toContain('run_in_background')
    }
  })

  test('a session launched in another mode gets the sync text, even after a switch to auto', () => {
    resetCodeModeGateForTesting()
    noteReplLaunchPermissionMode('default')
    for (const mode of ['default', 'auto'] as PermissionMode[]) {
      const prompt = promptFor(mode)
      expect(prompt).toContain('Your one tool is `REPL`; there are no other tools.')
      expect(prompt).toContain("\nA call's result is a `<repl-output>` element: `<log>` lines, then the `<result>` (or `<error>`).\n")
      expect(prompt).not.toContain('dispatched #')
      expect(prompt).not.toContain('The user can change the permission mode at any time.')
      expect(prompt).toContain('A script is stopped 600000 ms after it starts, counting the time spent waiting on permission prompts')
      expect(prompt).not.toContain('Timeouts cap at 600000 ms')
      expect(prompt).toContain('run_in_background')
    }
  })

  test('the MCP line names up to 40 servers', () => {
    resetCodeModeGateForTesting()
    noteReplLaunchPermissionMode('default')
    const mcp = Array.from({ length: 41 }, (_, i) => ({
      ...fakeRead,
      name: `mcp__s${i}__t`,
      isMcp: true,
      mcpInfo: { serverName: `s${i}`, toolName: 't' },
    }))
    const prompt = getReplPrompt([REPLTool, PollTool, fakeRead, ...mcp], { ...getEmptyToolPermissionContext(), mode: 'default' })
    expect(prompt).toContain('s38, s39 and 1 more. Find a tool with `searchTools`')
  })

  test('Code Mode drops unsandboxedRetry from ShellOutput in both lanes', () => {
    for (const launch of ['default', 'auto'] as PermissionMode[]) {
      resetCodeModeGateForTesting()
      noteReplLaunchPermissionMode(launch)
      const prompt = promptFor('default')
      expect(prompt).not.toContain('unsandboxedRetry')
      expect(prompt).not.toContain('the sandbox blocked the command')
      expect(prompt).toMatch(/ {4}error\?: string;\n {4}note\?: string;\n\}\n/)
    }
  })
})

/** The next turn's context: the same thread, a fresh abort controller. */
function contextAfterAbort(context: ToolUseContext): ToolUseContext {
  return { ...context, abortController: new AbortController() }
}
