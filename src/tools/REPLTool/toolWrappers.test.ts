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
import { dispatchModEvent } from '../../services/mods/dispatch.js'
import { buildSchemaNotSentHint } from '../../services/tools/toolExecution.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { REPL_TOOL_NAME } from './constants.js'
import {
  createReplToolHost,
  getReplCallableTools,
  McpToolError,
  REPL_CALLS_AFTER_STOP,
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
  options: { canUseTool?: CanUseToolFn; signal?: AbortSignal; asyncLane?: boolean; context?: ToolUseContext } = {},
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
  })
  return { host, context, progress }
}

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
  expect(user.message.content).toEqual([{ type: 'tool_result', tool_use_id: use.id, content: '' }])
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
