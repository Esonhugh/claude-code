import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { buildTool, getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import type { REPLToolCallProgress } from '../../types/tools.js'
import { AbortError } from '../../utils/errors.js'
import { createUserMessage, REJECT_MESSAGE } from '../../utils/messages.js'
import { dispatchModEvent } from '../../services/mods/dispatch.js'
import { buildSchemaNotSentHint } from '../../services/tools/toolExecution.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { REPL_TOOL_NAME, SCRIPT_ASK_DECLINED } from './constants.js'
import {
  createReplToolHost,
  getReplCallableTools,
  McpToolError,
  REPL_CALLS_AFTER_STOP,
  REPL_MAX_TOOL_CALLS,
} from './toolWrappers.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of [
  'userSettings',
  'projectSettings',
  'localSettings',
  'policySettings',
  'flagSettings',
] as const)
  setCachedSettingsForSource(source, {})
afterAll(() => {
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

const registered = getRegisteredHooks()
const interactive = getIsInteractive()
beforeEach(() => {
  clearRegisteredHooks()
  setIsInteractive(false)
})
afterEach(() => {
  clearRegisteredHooks()
  if (registered) registerHookCallbacks(registered)
  setIsInteractive(interactive)
})

const allow: CanUseToolFn = async () => ({ behavior: 'allow' })

function fixtureTool(
  name = 'Fixture',
  call: Tool['call'] = async input => ({ data: input }),
  extra: Partial<Tool> = {},
) {
  const inputSchema = z.object({ value: z.string() })
  return buildTool({
    name,
    inputSchema,
    outputSchema: z.object({ value: z.string() }),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    description: async () => name,
    prompt: async () => name,
    renderToolUseMessage: () => null,
    call,
    mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: typeof data === 'string' ? data : data.value,
    }),
    ...extra,
  } as Parameters<typeof buildTool>[0]) as Tool
}

function contextFor(tools: Tool[], permissions = getEmptyToolPermissionContext()) {
  return {
    options: { tools, mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: permissions, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
}

function hostFor(
  tools: Tool[],
  options: {
    canUseTool?: CanUseToolFn
    signal?: AbortSignal
    asyncLane?: boolean
    context?: ToolUseContext
    onHung?: (error: string) => void
  } = {},
) {
  const context = options.context ?? contextFor(tools)
  const progress: REPLToolCallProgress[] = []
  const host = createReplToolHost({
    context,
    canUseTool: options.canUseTool ?? allow,
    parentToolUseId: 'repl-parent',
    signal: options.signal ?? new AbortController().signal,
    asyncLane: options.asyncLane,
    onProgress: p => progress.push(p),
    onHung: options.onHung,
  })
  return { host, context, progress }
}

/** A tool whose call runs until `release()` or its abort. */
function heldTool(name: string) {
  let release!: () => void
  const released = new Promise<void>(resolve => (release = resolve))
  const tool = fixtureTool(name, async (input, context) => {
    await Promise.race([
      released,
      new Promise((_, reject) =>
        context.abortController.signal.addEventListener('abort', () => reject(new AbortError()), { once: true }),
      ),
    ])
    return { data: input }
  })
  return { tool, release }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

function hook(event: 'PreToolUse' | 'PostToolUse', output: Record<string, unknown>) {
  registerHookCallbacks({
    [event]: [{
      hooks: [{ type: 'callback', callback: async () => output }],
    }],
  })
}

test('the callable set drops REPL and denied tools, dedupes, and adds the primitives', () => {
  const repl = fixtureTool(REPL_TOOL_NAME)
  const fixture = fixtureTool()
  const other = fixtureTool('Other')
  const permissions = {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { localSettings: ['Other'] },
  }
  const names = getReplCallableTools(contextFor([repl, fixture, fixture, other], permissions)).map(t => t.name)
  expect(names).not.toContain(REPL_TOOL_NAME)
  expect(names).not.toContain('Other')
  expect(names.filter(name => name === 'Fixture')).toHaveLength(1)
  expect(names).toContain('Read')
})

test('a denied Edit also removes apply_patch from the callable set', () => {
  const permissions = {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { localSettings: ['Edit'] },
  }
  const names = getReplCallableTools(contextFor([fixtureTool('apply_patch')], permissions)).map(t => t.name)
  expect(names).not.toContain('Edit')
  expect(names).not.toContain('apply_patch')
})

test("the caller's canUseTool reaches the permission check unchanged", async () => {
  const received: CanUseToolFn[] = []
  const canUseTool: CanUseToolFn = async () => ({ behavior: 'allow' })
  const { host } = hostFor([fixtureTool('Fixture', async (input, _context, permission) => {
    received.push(permission)
    return { data: input }
  })], { canUseTool })
  await host.call('Fixture', { value: 'x' })
  expect(received).toEqual([canUseTool])
  expect(received[0]).toBe(canUseTool)
})

test('the permission check gets the original tool object, so the dialog matches the tool', async () => {
  const tool = fixtureTool()
  const asked: unknown[] = []
  const { host } = hostFor([tool], {
    canUseTool: (async (askedTool: unknown) => (asked.push(askedTool), { behavior: 'allow' })) as unknown as CanUseToolFn,
  })
  await host.call('Fixture', { value: 'x' })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toBe(tool)
})

test('the wall-clock error says a call was waiting to run, perhaps at a permission prompt', async () => {
  let answer!: () => void
  const asked = new Promise<void>(resolve => (answer = resolve))
  const { tool } = heldTool('Bash')
  const { host } = hostFor([tool], { canUseTool: async () => (await asked, { behavior: 'allow' }) as never })
  void host.call('Bash', { value: 'x' })
  await tick()
  expect(host.wallClockError(600_000)).toBe(
    'REPL execution exceeded its wall-clock limit of 10m while its Bash call was waiting to run. It may have been waiting for the user to answer a permission prompt, which is now closed. If so, running it again will ask the user again. Otherwise it may be hung in a hook or in a check of its directories.',
  )
  answer()
})

test('the wall-clock error tells a running shell call from other calls', async () => {
  const bash = heldTool('Bash')
  const other = heldTool('Fixture')
  const { host } = hostFor([bash.tool, other.tool])
  void host.call('Bash', { value: 'x' })
  await tick()
  expect(host.wallClockError(600_000)).toBe(
    'REPL execution exceeded its wall-clock limit of 10m before a shell call finished. The limit is on the whole script, and a command still running when it is reached is stopped with the script. A command whose own timeout ends before the limit moves to the background at that timeout and keeps running (one that starts with sleep is stopped instead), so give a long command a shorter timeout, or split the work.',
  )
  void host.call('Fixture', { value: 'y' })
  await tick()
  expect(host.wallClockError(600_000)).toBe(
    'REPL execution exceeded hard wall-clock limit of 600000ms. An inner tool call may be hung \u2014 try a shorter timeout on the tool itself, or split the work.',
  )
  bash.release()
  other.release()
})

test('the watchdog stops a call that runs far past its own timeout', async () => {
  const hung: string[] = []
  const { tool } = heldTool('Bash')
  const { host } = hostFor([tool], { onHung: error => hung.push(error) })
  const call = host.call('Bash', { value: 'x', timeout: 1 }).catch((error: unknown) => error)
  await new Promise(resolve => setTimeout(resolve, 5200))
  expect(hung).toEqual([
    'REPL inner tool call Bash exceeded 5002ms watchdog (native timeout 1). The call may be hung \u2014 try a shorter timeout on the tool itself.',
  ])
  expect(await call).toBeInstanceOf(AbortError)
}, 10_000)

test('a schema error inside REPL carries no ToolSearch hint', async () => {
  const previous = process.env.ENABLE_TOOL_SEARCH
  process.env.ENABLE_TOOL_SEARCH = 'true'
  try {
    const mcp = fixtureTool('mcp__srv__lookup', async input => ({ data: input }), {
      isMcp: true,
      mcpInfo: { serverName: 'srv', toolName: 'lookup' },
    } as Partial<Tool>)
    const tools = [mcp, fixtureTool('ToolSearch')]
    expect(buildSchemaNotSentHint(mcp, [], tools)).toContain('ToolSearch')
    const { host } = hostFor(tools)
    const error = (await host.call('mcp__srv__lookup', { value: 1 }).catch((e: unknown) => e)) as McpToolError
    expect(error).toBeInstanceOf(McpToolError)
    expect(error.message).toContain('InputValidationError')
    expect(error.message).not.toContain('schema was not sent')
  } finally {
    if (previous === undefined) delete process.env.ENABLE_TOOL_SEARCH
    else process.env.ENABLE_TOOL_SEARCH = previous
  }
})

test('an allowed call resolves the tool output and records a virtual pair', async () => {
  const seen: ToolUseContext[] = []
  const { host, progress } = hostFor([fixtureTool('Fixture', async (input, context) => {
    seen.push(context)
    return { data: input }
  })])
  expect(await host.call('Fixture', { value: 'hi' })).toEqual({ value: 'hi' })
  expect(host.callCount).toBe(1)
  expect(seen[0]).toMatchObject({
    innerCall: true,
    replScriptCall: true,
    fileReadingLimits: { maxTokens: Infinity, maxSizeBytes: 268_435_456 },
    globLimits: { maxResults: 25_000 },
  })
  expect(seen[0]!.options.tools.map(t => t.name)).not.toContain(REPL_TOOL_NAME)

  const [assistant, user, ...rest] = host.drainMessages()
  expect(rest).toEqual([])
  expect(host.drainMessages()).toEqual([])
  if (assistant?.type !== 'assistant' || user?.type !== 'user') throw new Error('bad pair')
  const use = assistant.message.content[0] as { type: string; id: string; name: string; input: unknown }
  expect(assistant.isVirtual).toBe(true)
  expect(use).toMatchObject({ type: 'tool_use', name: 'Fixture', input: { value: 'hi' } })
  expect(use.id).toMatch(/^repl_[0-9a-f-]{36}$/)
  expect(user.isVirtual).toBe(true)
  expect(user.toolUseResult).toEqual({ value: 'hi' })
  expect(user.sourceToolAssistantUUID).toBe(assistant.uuid)
  expect(user.message.content).toEqual([{ type: 'tool_result', tool_use_id: use.id, content: '', is_error: false }])
  expect(progress.map(p => p.phase)).toEqual(['start', 'executing', 'complete'])
  expect(progress.every(p => p.toolUseId === use.id && p.toolName === 'Fixture')).toBe(true)
})

test('a tool resolves by script name and alias', async () => {
  const { host } = hostFor([fixtureTool('my-tool', async input => ({ data: input }), { aliases: ['Old'] })])
  expect(host.tools.find(t => t.name === 'my-tool')).toEqual({
    name: 'my-tool', scriptName: 'my_tool', aliases: ['Old'], isMcp: false,
  })
  expect(await host.call('my_tool', { value: 'a' })).toEqual({ value: 'a' })
  expect(await host.call('Old', { value: 'b' })).toEqual({ value: 'b' })
  expect(host.call('Missing', {})).rejects.toThrow('Missing is not available in this REPL call')
})

for (const [label, decision] of [
  ['deny', { behavior: 'deny', message: 'not here', decisionReason: { type: 'other', reason: 'test' } }],
  ['ask', { behavior: 'ask', message: 'not here' }],
] as const)
  test(`a permission ${label} resolves {error} without running the tool`, async () => {
    const calls: unknown[] = []
    const { host, progress } = hostFor(
      [fixtureTool('Fixture', async input => (calls.push(input), { data: input }))],
      { canUseTool: (async () => decision) as unknown as CanUseToolFn },
    )
    expect(await host.call('Fixture', { value: 'x' })).toEqual({ error: 'Permission denied for Fixture: not here' })
    expect(calls).toEqual([])
    const [, user] = host.drainMessages()
    expect(user).toMatchObject({
      isVirtual: true,
      toolUseResult: { error: 'Permission denied for Fixture: not here' },
      permissionDecision: { decision: 'reject' },
      message: { content: [{ is_error: true, content: 'Permission denied for Fixture: not here' }] },
    })
    expect(progress.at(-1)?.phase).toBe('error')
  })

test('a tool error resolves {error} with the message', async () => {
  const { host } = hostFor([fixtureTool('Fixture', async () => {
    throw new Error('boom')
  })])
  expect(await host.call('Fixture', { value: 'x' })).toEqual({ error: 'boom' })
  expect(await host.call('Fixture', { value: 1 })).toEqual({
    error: expect.stringContaining('InputValidationError'),
  })
})

test('PreToolUse updatedInput reaches the tool', async () => {
  hook('PreToolUse', {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { value: 'hooked' } },
  })
  const { host } = hostFor([fixtureTool()])
  expect(await host.call('Fixture', { value: 'original' })).toEqual({ value: 'hooked' })
})

test('a PreToolUse block stops the call', async () => {
  const calls: unknown[] = []
  hook('PreToolUse', {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'hook says no' },
  })
  const { host } = hostFor([fixtureTool('Fixture', async input => (calls.push(input), { data: input }))])
  const result = (await host.call('Fixture', { value: 'x' })) as { error: string }
  expect(result.error).toStartWith('Permission denied for Fixture: ')
  expect(result.error).toContain('hook says no')
  expect(calls).toEqual([])
})

test('PostToolUse updatedToolOutput replaces the value', async () => {
  hook('PostToolUse', {
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { value: 'post' } },
  })
  const { host } = hostFor([fixtureTool()])
  expect(await host.call('Fixture', { value: 'x' })).toEqual({ value: 'post' })
})

test('Mods tool.call hooks see the inner call', async () => {
  const events: unknown[] = []
  const context = contextFor([fixtureTool()])
  context.mods = {
    capture: () => ({
      hasHooks: (event: string) => event === 'tool.call',
      release: () => {},
      dispatch: (
        event: string,
        input: Record<string, unknown>,
        core: (input: Record<string, unknown>) => Promise<unknown>,
        options?: { signal?: AbortSignal; validateResult?: (value: unknown) => void },
      ) =>
        dispatchModEvent({
          event, input, core, ...options,
          hooks: [{
            plugin: 'fixture',
            tier: 'user',
            registration: { id: 1, event: 'tool.call', hasCatch: false },
            invoke: async (e, next) => {
              events.push((e as { tool?: unknown }).tool)
              return next(e)
            },
          }],
        }),
    }),
  } as unknown as ToolUseContext['mods']
  const { host } = hostFor([], { context })
  expect(await host.call('Fixture', { value: 'x' })).toEqual({ value: 'x' })
  expect(events).toEqual(['Fixture'])
})

test('aborting the script signal aborts the inner tool and rejects', async () => {
  const script = new AbortController()
  const entered = Promise.withResolvers<void>()
  const { host, context, progress } = hostFor([fixtureTool('Fixture', async (_input, inner) => {
    entered.resolve()
    await new Promise<void>(resolve => inner.abortController.signal.addEventListener('abort', () => resolve()))
    throw new AbortError()
  })], { signal: script.signal })
  const pending = host.call('Fixture', { value: 'x' })
  await entered.promise
  script.abort()
  expect(pending).rejects.toBeInstanceOf(AbortError)
  await pending.catch(() => {})
  expect(context.abortController.signal.aborted).toBe(false)
  expect(progress.at(-1)?.phase).toBe('error')
  expect(host.call('Fixture', { value: 'y' })).rejects.toBeInstanceOf(AbortError)
})

/** A permission prompt the user declines with no feedback (PermissionContext `cancelAndAbort`). */
const declineAndAbort: CanUseToolFn = async (_tool, _input, inner) => {
  inner.abortController.abort()
  return { behavior: 'ask', message: REJECT_MESSAGE }
}

for (const asyncLane of [false, true]) {
  test(`a declined inner call stops the turn after its result${asyncLane ? ' (async lane: repl-ask-declined)' : ''}`, async () => {
    const { host, context, progress } = hostFor([fixtureTool()], { canUseTool: declineAndAbort, asyncLane })
    const value = await host.call('Fixture', { value: 'x' })
    expect(value).toEqual({ error: expect.stringContaining("doesn't want to proceed") })
    expect(host.calls().at(-1)).toMatchObject({ phase: 'error', declined: true })
    expect(progress.at(-1)?.phase).toBe('error')
    expect(context.abortController.signal.aborted).toBe(true)
    const reason = context.abortController.signal.reason as DOMException
    if (asyncLane) expect(reason).toBe(SCRIPT_ASK_DECLINED)
    else {
      const plain = new AbortController()
      plain.abort()
      expect([reason.name, reason.message]).toEqual(['AbortError', (plain.signal.reason as DOMException).message])
    }
  })
}

test('a call the tool itself aborts without a prompt is not a decline once its parent aborted', async () => {
  const { host, context } = hostFor([fixtureTool('Fixture', async (_input, inner) => {
    context.abortController.abort('user-cancel')
    await Promise.resolve()
    expect(inner.abortController.signal.aborted).toBe(true)
    throw new AbortError()
  })])
  expect(host.call('Fixture', { value: 'x' })).rejects.toBeInstanceOf(AbortError)
  await host.call('Fixture', { value: 'x' }).catch(() => {})
  expect(host.calls().some(call => call.declined)).toBe(false)
  expect(context.abortController.signal.reason).toBe('user-cancel')
})

test('an aborted session aborts the inner tool', async () => {
  const entered = Promise.withResolvers<void>()
  const { host, context } = hostFor([fixtureTool('Fixture', async (_input, inner) => {
    entered.resolve()
    await new Promise<void>(resolve => inner.abortController.signal.addEventListener('abort', () => resolve()))
    throw new AbortError()
  })])
  const pending = host.call('Fixture', { value: 'x' })
  await entered.promise
  context.abortController.abort()
  expect(pending).rejects.toBeInstanceOf(AbortError)
})

test('concurrent calls are capped by CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY', async () => {
  const previous = process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
  process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '2'
  try {
    let active = 0
    let peak = 0
    const gate = Promise.withResolvers<void>()
    const { host } = hostFor([fixtureTool('Fixture', async input => {
      peak = Math.max(peak, ++active)
      await gate.promise
      active--
      return { data: input }
    })])
    const calls = Array.from({ length: 5 }, (_, i) => host.call('Fixture', { value: String(i) }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(active).toBe(2)
    gate.resolve()
    expect((await Promise.all(calls)).map(r => (r as { value: string }).value)).toEqual(['0', '1', '2', '3', '4'])
    expect(peak).toBe(2)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
    else process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = previous
  }
})

test('MCP text is parsed as JSON and an MCP error throws McpToolError', async () => {
  const mcp = (call: Tool['call']) =>
    fixtureTool('mcp__srv__lookup', call, {
      isMcp: true,
      mcpInfo: { serverName: 'srv', toolName: 'lookup' },
      outputSchema: undefined,
      mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: String(data) }],
      }),
    } as Partial<Tool>)
  const ok = hostFor([mcp(async () => ({ data: '1}' }))]).host
  expect(ok.tools.find(t => t.isMcp)).toEqual({
    name: 'mcp__srv__lookup', scriptName: 'mcp__srv__lookup', aliases: [], isMcp: true, mcpServer: 'srv',
  })
  expect(await ok.call('mcp__srv__lookup', { value: 'x' })).toEqual({ a: 1 })
  const raw = hostFor([mcp(async () => ({ data: 'oops' }))]).host
  expect(await raw.call('mcp__srv__lookup', { value: 'x' })).toBe('{"a":oops')

  const failing = hostFor([mcp(async () => {
    throw new Error('{"code":42}')
  })]).host
  const error = (await failing.call('mcp__srv__lookup', { value: 'x' }).catch((e: unknown) => e)) as McpToolError
  expect(error).toBeInstanceOf(McpToolError)
  expect(error.detail).toEqual({ code: 42 })
  expect(failing.drainMessages()).toHaveLength(2)
})

test('the async lane refuses run_in_background for shell tools', async () => {
  const calls: unknown[] = []
  const bash = fixtureTool('Bash', async input => (calls.push(input), { data: input }), {
    inputSchema: z.object({ command: z.string(), run_in_background: z.boolean().optional() }),
  } as Partial<Tool>)
  const { host } = hostFor([bash], { asyncLane: true })
  expect(await host.call('Bash', { command: 'sleep 1', run_in_background: true })).toEqual({
    error: 'Bash: run_in_background is not available in the async REPL. The eval already runs in the background, so await the command instead.',
  })
  expect(calls).toEqual([])
})

test(`after stop at most ${REPL_CALLS_AFTER_STOP} more calls run`, async () => {
  const { host } = hostFor([fixtureTool()])
  host.stop()
  for (let i = 0; i < REPL_CALLS_AFTER_STOP; i++)
    expect(await host.call('Fixture', { value: String(i) })).toEqual({ value: String(i) })
  expect(host.call('Fixture', { value: 'late' })).rejects.toThrow('stopped')
  expect(host.callCount).toBe(REPL_CALLS_AFTER_STOP)
})

test(`a script's call past its ${REPL_MAX_TOOL_CALLS.toLocaleString('en-US')}th throws once, and later calls never settle`, async () => {
  const { host } = hostFor([fixtureTool()])
  for (let i = 0; i < REPL_MAX_TOOL_CALLS; i += 1000)
    await Promise.all(Array.from({ length: 1000 }, () => host.call('Fixture', { value: 'x' })))
  await expect(host.call('Fixture', { value: 'x' })).rejects.toThrow(
    'Fixture: this script has made 50,000 calls, its cap. The call was not made, and no later call of this script will be answered.',
  )
  const late = await Promise.race([host.call('Fixture', { value: 'x' }), tick().then(() => 'unsettled')])
  expect(late).toBe('unsettled')
  expect(host.callCount).toBe(REPL_MAX_TOOL_CALLS)
}, 120_000)

const PNG = 'iVBORw0KGgo'
const moved = (b64: string, kind = 'image') =>
  `[${b64.length} base64 chars — ${kind} bytes moved to the REPL result, subject to its per-result ${kind} cap]`

function readTool(call: Tool['call']) {
  return fixtureTool('Read', call, {
    inputSchema: z.object({ file_path: z.string(), pages: z.string().optional() }),
    outputSchema: z.any(),
  } as Partial<Tool>)
}

test('an image Read hands the script a placeholder and keeps the base64 on the call record', async () => {
  const image = { type: 'image', file: { base64: PNG, type: 'image/png', originalSize: 8 } }
  const { host, context } = hostFor([readTool(async () => ({ data: image }))])
  const value = await host.call('Read', { file_path: 'a.png' })
  expect(value).toEqual({ ...image, file: { ...image.file, base64: moved(PNG) } })
  expect(host.calls()[0]).toMatchObject({ phase: 'complete', value: image })
  const virtual = host.drainMessages().find(m => m.type === 'user') as { toolUseResult?: unknown }
  expect(virtual.toolUseResult).toEqual(value)
  expect(context.abortController.signal.aborted).toBe(false)
})

test('a paged Read gets its page images as pages, the script seeing placeholders', async () => {
  const parts = { type: 'parts', file: { filePath: 'a.pdf', originalSize: 9, count: 2, outputDir: '/x' } }
  const page = (data: string) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } })
  const { host } = hostFor([readTool(async () => ({
    data: parts,
    newMessages: [createUserMessage({ content: [page('AAAA'), page('BBBBBB')], isMeta: true })],
  }))])
  const value = await host.call('Read', { file_path: 'a.pdf', pages: '3-4' })
  expect(value).toEqual({
    ...parts,
    firstPage: 3,
    pages: [{ base64: moved('AAAA'), mediaType: 'image/jpeg' }, { base64: moved('BBBBBB'), mediaType: 'image/jpeg' }],
  })
  expect(host.calls()[0]?.value).toEqual({
    ...parts,
    firstPage: 3,
    pages: [{ base64: 'AAAA', mediaType: 'image/jpeg' }, { base64: 'BBBBBB', mediaType: 'image/jpeg' }],
  })
})

test('an MCP image block reaches the script as a placeholder, marked as MCP content', async () => {
  const blocks = [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]
  const mcp = fixtureTool('mcp__s__shot', async () => ({ data: blocks }), {
    isMcp: true,
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  } as Partial<Tool>)
  const { host } = hostFor([mcp])
  const value = await host.call('mcp__s__shot', { value: 'x' })
  expect(value).toEqual([blocks[0], { ...blocks[1], source: { ...blocks[1]!.source, data: moved(PNG) } }])
  expect(host.calls()[0]).toMatchObject({ mcpContent: true, value: blocks })
})

test('the virtual tool_result always carries is_error, as 2.1.325', async () => {
  const { host } = hostFor([fixtureTool()])
  await host.call('Fixture', { value: 'x' })
  const result = host
    .drainMessages()
    .flatMap(message => (message.type === 'user' && Array.isArray(message.message.content) ? message.message.content : []))
    .find(block => block.type === 'tool_result')
  expect(result).toMatchObject({ type: 'tool_result', content: '', is_error: false })
})

test("a script's call cannot set the turn's tool JSX, so Esc still reaches the dispatched script", async () => {
  const shown: unknown[] = []
  const seen: unknown[] = []
  const tool = fixtureTool('Fixture', async (input, context) => {
    seen.push(context.setToolJSX)
    context.setToolJSX?.({ jsx: null, shouldHidePromptInput: false })
    return { data: input }
  })
  const context = { ...contextFor([tool]), setToolJSX: (jsx: unknown) => shown.push(jsx) } as unknown as ToolUseContext
  const { host } = hostFor([tool], { context })
  await host.call('Fixture', { value: 'x' })
  expect(seen).toEqual([undefined])
  expect(shown).toEqual([])
})
