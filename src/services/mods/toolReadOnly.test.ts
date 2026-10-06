import { afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { resetSettingsCache, setSessionSettingsCache, setCachedSettingsForSource } from '../../utils/settings/settingsCache.js'
import { runToolUse } from '../tools/toolExecution.js'
import { dispatchModEvent } from './dispatch.js'
import { createModToolHost } from './toolHost.js'
import type { ModSnapshot } from './runtime.js'
import type { ModDispatchHook } from './types.js'
import type { ToolCallResult } from './toolAdapter.js'

const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']
let root: string
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = envKeys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mod-readonly-')))
  for (const key of envKeys) delete process.env[key]
  Object.assign(process.env, { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), ANTHROPIC_API_KEY: 'sk-test-placeholder' })
  resetSettingsCache()
  getProjectDir.cache.clear?.()
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const) setCachedSettingsForSource(source, {})
})
afterEach(async () => {
  resetSettingsCache()
  getProjectDir.cache.clear?.()
  envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})

function hooks(...invoke: ModDispatchHook['invoke'][]): ModDispatchHook[] {
  return invoke.map((fn, index) => ({ plugin: `observer-${index}`, tier: 'user', registration: { id: index + 1, event: 'tool.call', hasCatch: false }, invoke: fn }))
}

async function dispatch(output: unknown, handlers: ModDispatchHook[]) {
  return dispatchModEvent({ event: 'tool.call', input: { tool: 'Fixture', tool_use_id: 'call' }, hooks: handlers, core: async () => output })
}

// Source-confirmed: upstream 2.1.292 strips and derives this marker at every
// hook boundary from that hook's own downstream ref and unchanged JSON result.
test('an unchanged referenced core result retains read-only even if the hook omits the marker', async () => {
  const result = { b: 2, a: 1 }
  expect(await dispatch({ ref: 1, result, isReadOnly: true }, hooks(async (e, next) => {
    const value = await next(e) as ToolCallResult
    return { ref: value.ref, result: { a: 1, b: 2 } }
  }))).toEqual({ ref: 1, result: { a: 1, b: 2 }, isReadOnly: true })
})

for (const kind of ['changed', 'unreferenced', 'write', 'invented-ref', 'deny', 'synthetic'] as const) {
  test(`a ${kind} hook answer cannot claim read-only`, async () => {
    const answer = await dispatch({ ref: 1, result: { a: 1 }, ...(kind === 'write' ? {} : { isReadOnly: true }) }, hooks(async (e, next) => {
      if (kind === 'synthetic') return { result: { a: 1 }, isReadOnly: true }
      const value = await next(e) as ToolCallResult
      if (kind === 'deny') return { deny: 'blocked', isReadOnly: true }
      return { ...value, result: kind === 'changed' ? { a: 2 } : value.result, ref: kind === 'unreferenced' ? undefined : kind === 'invented-ref' ? 99 : value.ref, isReadOnly: true }
    }))
    expect(answer).not.toHaveProperty('isReadOnly')
  })
}

test('a removed ref cannot be recreated by an upstream observer', async () => {
  let observed: unknown
  const answer = await dispatch({ ref: 1, result: { a: 1 }, isReadOnly: true }, hooks(
    async (e, next) => { observed = await next(e); return { ...(observed as object), ref: 1, isReadOnly: true } },
    async (e, next) => { const value = await next(e) as ToolCallResult; return { result: value.result } },
  ))
  expect(observed).not.toHaveProperty('isReadOnly')
  expect(answer).not.toHaveProperty('isReadOnly')
})

test('read-only follows the selected execution, not the last next call', async () => {
  let ref = 0
  const answer = await dispatchModEvent({ event: 'tool.call', input: { tool: 'Fixture', tool_use_id: 'call' }, hooks: hooks(async (e, next) => {
    const first = await next(e)
    await next(e)
    return first
  }), core: async () => ({ ref: ++ref, result: ref, ...(ref === 1 ? { isReadOnly: true } : {}) }) })
  expect(answer).toEqual({ ref: 1, result: 1, isReadOnly: true })
})

test('a catch handler is subject to the same read-only provenance check', async () => {
  const handlers = hooks(async (e, next, catching) => {
    if (catching) return { ...(await next(e) as object), result: { a: 2 }, isReadOnly: true }
    await next(e)
    throw new Error('recover')
  })
  handlers[0]!.registration.hasCatch = true
  expect(await dispatch({ ref: 1, result: { a: 1 }, isReadOnly: true }, handlers)).toEqual({ ref: 1, result: { a: 2 } })
})

test('frozen receipts and cyclic replacements are handled without mutating downstream data', async () => {
  const original = Object.freeze({ ref: 1, result: { a: 1 }, isReadOnly: true })
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  const answer = await dispatch(original, hooks(async (e, next) => { await next(e); return Object.freeze({ ref: 1, result: cyclic, isReadOnly: true }) }))
  expect(answer).not.toHaveProperty('isReadOnly')
  expect(original.isReadOnly).toBe(true)
})

function fixture(handlers: ModDispatchHook[] = [], rewrite?: boolean) {
  const called: unknown[] = []
  const checked: unknown[] = []
  const tool = {
    name: 'ReadOnlyFixture', inputSchema: z.strictObject({ read: z.boolean(), fail: z.boolean().optional() }), outputSchema: z.object({ value: z.string() }), maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    isReadOnly: (input: unknown) => { checked.push(input); return (input as { read: boolean }).read },
    checkPermissions: async () => ({ behavior: 'ask', message: 'Confirm fixture' }),
    call: async (input: unknown) => { called.push(input); if ((input as { fail?: boolean }).fail) throw new Error('fixture execution failed'); return { data: { value: 'ran' } } },
    mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data.value }),
  } as unknown as Tool
  const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
  const snapshot: ModSnapshot = { hasHooks: () => true, dispatch: (event, input, core, options) => dispatchModEvent({ event, input, core, ...options, hooks: handlers }), release() {} }
  const context = { options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true }, abortController: new AbortController(), messages: [], getAppState: () => state, setAppState: () => {}, setInProgressToolUseIDs: () => {}, modsSnapshot: snapshot } as unknown as ToolUseContext
  const canUseTool: CanUseToolFn = async (_tool, input) => ({ behavior: 'allow', ...(rewrite === undefined ? {} : { updatedInput: { ...input, read: rewrite } }) })
  async function run(input: unknown) {
    let receipt: ToolCallResult | undefined
    const block = { type: 'tool_use' as const, caller: { type: 'direct' as const }, id: 'readonly-call', name: tool.name, input }
    const assistant = createAssistantMessage({ content: [block] })
    const updates = []
    for await (const update of runToolUse(block, assistant, canUseTool, { ...context, modToolCallResult: value => { receipt = value } })) updates.push(update)
    return { receipt, updates }
  }
  return { tool, context, snapshot, canUseTool, called, checked, run }
}

for (const read of [true, false]) {
  for (const fail of [false, true]) {
    test(`real executor marks read=${read}, fail=${fail} only after admission`, async () => {
      const f = fixture()
      const { receipt, updates } = await f.run({ read, fail })
      expect(f.called).toEqual([{ read, fail }])
      expect(f.checked).toContainEqual({ read, fail })
      expect(receipt?.isReadOnly).toBe(read ? true : undefined)
      expect(receipt?.isError).toBe(fail ? true : undefined)
      expect(updates.some(update => update.message.type === 'user')).toBe(true)
    })
  }
}

for (const rewrite of [true, false]) {
  test(`permission input rewrite to read=${rewrite} determines the marker`, async () => {
    const f = fixture([], rewrite)
    const { receipt } = await f.run({ read: !rewrite })
    expect(f.called).toEqual([{ read: rewrite }])
    expect(receipt?.isReadOnly).toBe(rewrite ? true : undefined)
  })
}

test('a denied execution never classifies the unexecuted input', async () => {
  const f = fixture(hooks(async () => ({ deny: 'blocked' })))
  const { receipt } = await f.run({ read: true })
  expect(receipt).toEqual({ deny: 'blocked' })
  expect(f.called).toEqual([])
  expect(f.checked).toEqual([])
})

test('author calls expose read-only to observing hooks but strip it from the author receipt', async () => {
  let observed: unknown
  const f = fixture(hooks(async (e, next) => { observed = await next(e); return observed }))
  const result = await createModToolHost(f.context, f.canUseTool).call({ tool: f.tool.name, read: true }, f.snapshot, new AbortController().signal)
  expect(observed).toMatchObject({ ref: 1, result: { value: 'ran' }, isReadOnly: true })
  expect(result).toMatchObject({ ref: 1, result: { value: 'ran' } })
  expect(result).not.toHaveProperty('isReadOnly')
})

for (const kind of ['copy', 'changed', 'write'] as const) {
  test(`same-plugin ${kind} is observed internally before the host settles provenance`, async () => {
    let seen: unknown
    const handlers = hooks(
      async (e, next) => { seen = await next(e); return seen },
      async (e, next) => {
        const original = await next(e) as ToolCallResult
        return kind === 'copy'
          ? { ref: original.ref, result: { a: 1 } }
          : { ...original, result: kind === 'changed' ? { a: 2 } : original.result, isReadOnly: true }
      },
    )
    handlers[1]!.plugin = handlers[0]!.plugin
    const answer = await dispatch({ ref: 1, result: { a: 1 }, ...(kind === 'write' ? {} : { isReadOnly: true }) }, handlers)
    expect((seen as { isReadOnly?: true }).isReadOnly).toBe(kind === 'copy' ? undefined : true)
    expect((answer as { isReadOnly?: true }).isReadOnly).toBe(kind === 'copy' ? true : undefined)
  })
}
