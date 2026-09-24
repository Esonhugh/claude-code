import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  getSessionSettingsCache,
  setSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../../utils/settings/settingsCache.js'
import { runToolUse } from './toolExecution.js'
import { dispatchModEvent } from '../mods/dispatch.js'
import type { ModDispatchHook } from '../mods/types.js'
import {
  getIsInteractive,
  setIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  clearRegisteredHooks,
} from '../../bootstrap/state.js'
import { createModsRuntime } from '../mods/runtime.js'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import { getToolResultPath } from '../../utils/toolResultStorage.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'

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

test('author result callback runs without tool.call hooks and is not inherited by the tool', async () => {
  const runtime = createModsRuntime()
  const f = fixture(async (event, next) => next(event))
  const results: unknown[] = []
  const inherited: unknown[] = []
  f.context.mods = runtime
  f.context.modToolCallResult = result => results.push(result)
  f.tool.call = async (input, context) => {
    inherited.push(context.modToolCallResult)
    return { data: input }
  }
  try {
    await Array.fromAsync(runToolUse(
      f.block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    ))
    expect(results).toEqual([{ ref: 1, result: { value: 'original' }, text: 'original' }])
    expect(inherited).toEqual([undefined])
  } finally {
    await runtime.dispose()
  }
})

function fixture(
  invoke: ModDispatchHook['invoke'],
  toolName = 'ModFixture',
) {
  const calls: unknown[] = []
  const validation: unknown[] = []
  let releases = 0
  const hooks = new Map()
  const tool = {
    name: toolName,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    validateInput: async (input: unknown) => {
      validation.push(input)
      return { result: true }
    },
    call: async (input: unknown) => {
      calls.push(input)
      return { data: input }
    },
    mapToolResultToToolResultBlockParam: (
      data: { value: string },
      id: string,
    ) => ({ type: 'tool_result', tool_use_id: id, content: data.value }),
  } as unknown as Tool
  const snapshot = {
    hasHooks: (event: string) => event === 'tool.call',
    release: () => {
      releases++
    },
    dispatch: (
      event: string,
      input: Record<string, unknown>,
      core: (input: Record<string, unknown>) => Promise<unknown>,
      options?: {
        signal?: AbortSignal
        validateResult?: (value: unknown) => void
      },
    ) =>
      dispatchModEvent({
        event,
        input,
        core,
        ...options,
        hooks: [
          {
            plugin: 'fixture',
            tier: 'user',
            registration: { id: 1, event: 'tool.call', hasCatch: false },
            invoke,
          },
        ],
      }),
  }
  const context = {
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionHooks: hooks,
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    mods: { capture: () => snapshot },
  } as unknown as ToolUseContext
  const block = {
    type: 'tool_use' as const,
    caller: { type: 'direct' as const },
    id: 'test-tool-call',
    name: tool.name,
    input: { value: 'original' },
  }
  const assistant = createAssistantMessage({ content: [block] })
  return {
    calls,
    validation,
    context,
    block,
    assistant,
    tool,
    hooks,
    releases: () => releases,
  }
}

async function workerFixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'mods-tool-cancellation-'))
  const diagnostics: string[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event.message),
  })
  const cleanup = async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, source)
    await runtime.reconcile([
      {
        name: 'cancellation-fixture',
        storageId: 'cancellation-fixture@inline',
        pluginRoot: root,
        entrypoints: [entry],
      },
    ])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('tool.call')).toBe(true)
    const f = fixture(async (event, next) => next(event))
    f.context.mods = runtime
    return { ...f, runtime, diagnostics, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('tool cancellation deadline exceeded')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('Mods at the whole tool execution boundary', () => {
  test('real Worker early return cancels its pending Tool.call without aborting the query', async () => {
    const f = await workerFixture(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        void next({ ...e, value: 'waiting' }).catch(() => {});
        await next({ ...e, value: 'checkpoint' });
        return { result: { value: 'synthetic' } };
      });
    }`)
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const controllers: AbortController[] = []
    f.tool.call = async (input, context) => {
      f.calls.push(input)
      controllers.push(context.abortController)
      if (input.value === 'waiting') {
        const signal = context.abortController.signal
        const onAbort = () => { aborted.resolve(); finish.resolve() }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        entered.resolve()
        try { await finish.promise }
        finally { signal.removeEventListener('abort', onAbort) }
      } else {
        await entered.promise
      }
      return { data: input }
    }
    const running = Array.fromAsync(runToolUse(
      f.block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    ))
    try {
      await within(aborted.promise)
      const updates = await within(running)
      expect(f.calls).toEqual([{ value: 'waiting' }, { value: 'checkpoint' }])
      expect(controllers[0]).not.toBe(f.context.abortController)
      expect(controllers[1]).not.toBe(controllers[0])
      expect(controllers[0]!.signal.aborted).toBe(true)
      expect(controllers[1]!.signal.aborted).toBe(false)
      expect(f.context.abortController.signal.aborted).toBe(false)
      expect(JSON.stringify(updates)).toContain('synthetic')
      expect(f.diagnostics).toEqual([])
    } finally {
      finish.resolve()
      await running
      await f.cleanup()
    }
  })

  test('real Worker early return drains a non-cooperative tool before releasing cancellation listeners', async () => {
    const f = await workerFixture(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        void next({ ...e, value: 'waiting' }).catch(() => {});
        await next({ ...e, value: 'checkpoint' });
        return { result: { value: 'synthetic' } };
      });
    }`)
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    f.tool.call = async (input, context) => {
      f.calls.push(input)
      if (input.value === 'waiting') {
        const signal = context.abortController.signal
        const onAbort = () => aborted.resolve()
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        entered.resolve()
        try { await finish.promise }
        finally { signal.removeEventListener('abort', onAbort) }
      } else {
        await entered.promise
      }
      return { data: input }
    }
    let settled = false
    const running = Array.fromAsync(runToolUse(
      f.block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    )).finally(() => { settled = true })
    try {
      await within(aborted.promise)
      expect(settled).toBe(false)
      expect(getEventListeners(f.context.abortController.signal, 'abort').length).toBeGreaterThan(0)
      expect(f.context.abortController.signal.aborted).toBe(false)
      finish.resolve()
      expect(JSON.stringify(await within(running))).toContain('synthetic')
      expect(f.calls).toEqual([{ value: 'waiting' }, { value: 'checkpoint' }])
      expect(getEventListeners(f.context.abortController.signal, 'abort')).toHaveLength(0)
      expect(f.diagnostics).toEqual([])
    } finally {
      finish.resolve()
      await running
      await f.cleanup()
    }
  })

  test('real Worker parent abort reaches concurrent executions through independent controllers', async () => {
    const f = await workerFixture(`export function register(on) {
      on('tool.call', ($, e, next) => next(e));
    }`)
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const controllers: AbortController[] = []
    const aborted: AbortSignal[] = []
    f.tool.call = async (input, context) => {
      f.calls.push(input)
      const controller = context.abortController
      controllers.push(controller)
      const signal = controller.signal
      const stopped = Promise.withResolvers<void>()
      const onAbort = () => { aborted.push(signal); stopped.resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      if (controllers.length === 2) entered.resolve()
      try {
        await Promise.race([stopped.promise, finish.promise])
        signal.throwIfAborted()
        return { data: input }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const blocks = ['first', 'second'].map(value => ({
      ...f.block, id: `parent-abort-${value}`, input: { value },
    }))
    const running = Promise.all(blocks.map(block => Array.fromAsync(runToolUse(
      block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    ))))
    try {
      await within(entered.promise)
      expect(controllers[0]).not.toBe(controllers[1])
      for (const controller of controllers)
        expect(controller).not.toBe(f.context.abortController)
      f.context.abortController.abort(new Error('query cancelled'))
      const updates = await within(running)
      expect(aborted).toHaveLength(2)
      expect(f.calls).toHaveLength(2)
      for (const result of updates) {
        const blocks = result.flatMap(update => update.message.type === 'user' && Array.isArray(update.message.message.content)
          ? update.message.message.content.filter(block => block.type === 'tool_result') : [])
        expect(blocks).toHaveLength(1)
        expect(blocks[0]!.is_error).toBe(true)
      }
    } finally {
      finish.resolve()
      await running
      await f.cleanup()
    }
  })

  test('real Worker branch cancellation leaves another next branch and the query running', async () => {
    const f = await workerFixture(`export function register(on) {
      on('tool.call', async ($, e, next) => {
        const cancelled = next({ ...e, value: 'cancelled' });
        const sibling = next({ ...e, value: 'sibling' });
        await cancelled;
        return sibling;
      });
      on('tool.call', { value: 'cancelled' }, async ($, e, next) => {
        void next(e).catch(() => {});
        await next({ ...e, value: 'checkpoint' });
        return { result: { value: 'synthetic' } };
      });
    }`)
    const entered = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const controllers = new Map<string, AbortController>()
    f.tool.call = async (input, context) => {
      f.calls.push(input)
      const value = input.value
      if (typeof value !== 'string') throw new Error('expected string value')
      controllers.set(value, context.abortController)
      if (value === 'checkpoint') {
        await entered.promise
        return { data: input }
      }
      if (controllers.has('cancelled') && controllers.has('sibling')) entered.resolve()
      const signal = context.abortController.signal
      const stopped = Promise.withResolvers<void>()
      const onAbort = () => {
        if (value === 'cancelled') cancelled.resolve()
        stopped.resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      try {
        await Promise.race([stopped.promise, finish.promise])
        return { data: input }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
    let settled = false
    const running = Array.fromAsync(runToolUse(
      f.block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    )).finally(() => { settled = true })
    try {
      await within(cancelled.promise)
      expect(settled).toBe(false)
      expect(controllers.get('cancelled')!.signal.aborted).toBe(true)
      expect(controllers.get('sibling')!.signal.aborted).toBe(false)
      expect(f.context.abortController.signal.aborted).toBe(false)
      finish.resolve()
      const updates = await within(running)
      expect(f.calls).toHaveLength(3)
      expect(JSON.stringify(updates)).toContain('sibling')
      expect(f.diagnostics).toEqual([])
    } finally {
      finish.resolve()
      await running
      await f.cleanup()
    }
  })

  test.each(['normal', 'catch-replay', 'pending-catch-replay'])(
    'real Worker %s keeps real execution live and never duplicates permissions or Tool.call',
    async mode => {
      const f = await workerFixture(`export function register(on) {
        on('tool.call', async ($, e, next) => {
          ${mode === 'pending-catch-replay'
            ? "void next(e).catch(() => {}); throw Error('recover pending');"
            : `const result = await next(e); ${mode === 'catch-replay' ? "throw Error('recover completed');" : 'return result;'}`}
        }).catch(async ($, e, next) => {
          const first = await next({ ...e, value: 'must not execute' });
          await next({ ...e, value: 'also must not execute' });
          return first;
        });
      }`)
      const entered = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      let controller: AbortController | undefined
      let aborted = 0
      let permissions = 0
      f.tool.call = async (input, context) => {
        f.calls.push(input)
        controller = context.abortController
        const onAbort = () => { aborted++; finish.resolve() }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
        entered.resolve()
        try {
          await finish.promise
          controller.signal.throwIfAborted()
          return { data: input }
        } finally {
          controller.signal.removeEventListener('abort', onAbort)
        }
      }
      const running = Array.fromAsync(runToolUse(
        f.block, f.assistant,
        async () => { permissions++; return { behavior: 'allow' } },
        f.context,
      ))
      try {
        await within(entered.promise)
        expect(controller).not.toBe(f.context.abortController)
        expect(controller!.signal.aborted).toBe(false)
        finish.resolve()
        const updates = await within(running)
        expect(aborted).toBe(0)
        expect(controller!.signal.aborted).toBe(false)
        expect(f.context.abortController.signal.aborted).toBe(false)
        expect(f.calls).toEqual([{ value: 'original' }])
        expect(f.validation).toEqual([{ value: 'original' }])
        expect(permissions).toBe(1)
        expect(JSON.stringify(updates)).toContain('original')
        expect(JSON.stringify(updates)).not.toContain('must not execute')
        expect(f.diagnostics).toEqual(mode === 'normal' ? [] : [
          mode === 'pending-catch-replay' ? 'recover pending' : 'recover completed',
        ])
        expect(getEventListeners(f.context.abortController.signal, 'abort')).toHaveLength(0)
        f.context.abortController.abort(new Error('after execution settled'))
        expect(controller!.signal.aborted).toBe(false)
      } finally {
        finish.resolve()
        await running
        await f.cleanup()
      }
    },
  )

  test('rewritten arguments pass through validateInput and permission denial before Tool.call', async () => {
    const f = fixture(async (e, next) => next({ ...e, value: 'rewritten' }))
    const permissionInputs: unknown[] = []
    const updates = await Array.fromAsync(
      runToolUse(
        f.block,
        f.assistant,
        async (_tool, input) => {
          permissionInputs.push(input)
          return {
            behavior: 'deny',
            message: 'test permission denied',
            decisionReason: { type: 'other', reason: 'test' },
          }
        },
        f.context,
      ),
    )
    expect(f.validation).toEqual([{ value: 'rewritten' }])
    expect(permissionInputs).toEqual([{ value: 'rewritten' }])
    expect(f.calls).toEqual([])
    expect(
      updates.some(
        update =>
          update.message.type === 'user' &&
          Array.isArray(update.message.message.content) &&
          update.message.message.content.some(
            block => block.type === 'tool_result' && block.is_error,
          ),
      ),
    ).toBe(true)
    expect(f.releases()).toBe(1)
  })

  test('a rewritten ask decision cannot be converted into Mod success or execute the tool', async () => {
    const f = fixture(async (e, next) => {
      await next({ ...e, value: 'needs approval' })
      return { result: { value: 'must-not-mask-ask' } }
    })
    const permissionInputs: unknown[] = []
    const updates = await Array.fromAsync(runToolUse(f.block, f.assistant, async (_tool, input) => {
      permissionInputs.push(input)
      return { behavior: 'ask', message: 'fixture approval required' }
    }, f.context))
    expect(permissionInputs).toEqual([{ value: 'needs approval' }])
    expect(f.calls).toEqual([])
    const results = updates.flatMap(update => update.message.type === 'user' && Array.isArray(update.message.message.content)
      ? update.message.message.content.filter(block => block.type === 'tool_result') : [])
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    expect(JSON.stringify(results)).not.toContain('must-not-mask-ask')
    expect(f.releases()).toBe(1)
  })

  test('invalid rewritten arguments reach input schema before validation or permissions', async () => {
    const f = fixture(async (e, next) => next({ ...e, value: 42 }))
    let permissions = 0
    const updates = await Array.fromAsync(
      runToolUse(
        f.block,
        f.assistant,
        async () => {
          permissions++
          return { behavior: 'allow' }
        },
        f.context,
      ),
    )
    expect(f.validation).toEqual([])
    expect(permissions).toBe(0)
    expect(f.calls).toEqual([])
    expect(JSON.stringify(updates)).toContain('InputValidationError')
  })

  test('preserves classic hook order and count around the actual permission and call boundary', async () => {
    const order: string[] = []
    const f = fixture(async (e, next) => {
      order.push('mod before')
      const result = await next(e)
      order.push('mod after')
      return result
    })
    const registered = getRegisteredHooks()
    clearRegisteredHooks()
    registerHookCallbacks(
      Object.fromEntries(
        ['PreToolUse', 'PostToolUse'].map(event => [
          event,
          [
            {
              matcher: f.tool.name,
              hooks: [
                {
                  type: 'callback',
                  internal: true,
                  callback: async () => {
                    order.push(event)
                    return {}
                  },
                },
              ],
            },
          ],
        ]),
      ),
    )
    f.tool.call = async input => {
      order.push('call')
      return { data: input }
    }
    const interactive = getIsInteractive()
    setIsInteractive(false)
    try {
      await Array.fromAsync(
        runToolUse(
          f.block,
          f.assistant,
          async () => {
            order.push('permission')
            return { behavior: 'allow' }
          },
          f.context,
        ),
      )
    } finally {
      setIsInteractive(interactive)
      clearRegisteredHooks()
      if (registered) registerHookCallbacks(registered)
    }
    expect(order).toEqual([
      'mod before',
      'PreToolUse',
      'permission',
      'call',
      'PostToolUse',
      'mod after',
    ])
  })

  test('streams progress before final reconciliation and waits for unawaited execution on return', async () => {
    const finish = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(async (e, next) => {
      void next(e).catch(() => {})
      await entered.promise
      return { result: { value: 'synthetic' } }
    })
    f.tool.call = async (
      _input,
      _context,
      _permission,
      _assistant,
      progress,
    ) => {
      progress?.({
        toolUseID: f.block.id,
        data: {
          type: 'bash_progress',
          output: 'running',
          fullOutput: 'running',
          elapsedTimeSeconds: 0,
          totalLines: 1,
          totalBytes: 7,
        },
      } as never)
      entered.resolve()
      await finish.promise
      return { data: { value: 'actual' } }
    }
    const generator = runToolUse(
      f.block,
      f.assistant,
      async () => ({ behavior: 'allow' }),
      f.context,
    )
    const progress = await generator.next()
    expect(progress.value && progress.value.message.type).toBe('progress')
    let returned = false
    const closing = generator.return().then(() => {
      returned = true
    })
    await Promise.resolve()
    expect(returned).toBe(false)
    expect(f.releases()).toBe(0)
    finish.resolve()
    await closing
    expect(f.releases()).toBe(1)
  })

  test('direct tool admission exposes the current assistant response to session.usage', async () => {
    const f = await workerFixture(`export function register(on) {
      on('tool.call', async $ => ({result:{value:String((await $.session.usage()).context.tokens)}}));
    }`)
    Object.assign(f.assistant.message, {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 2000,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 7000,
        output_tokens: 1,
      },
    })
    f.context.options.mainLoopModel = 'claude-sonnet-4-6'
    f.context.options.agentDefinitions = {
      activeAgents: [],
      allAgents: [],
    }
    try {
      const updates = await Array.fromAsync(
        runToolUse(
          f.block,
          f.assistant,
          async () => ({ behavior: 'allow' }),
          f.context,
        ),
      )
      expect(JSON.stringify(updates)).toContain('10000')
      expect(f.calls).toEqual([])
      expect(f.diagnostics).toEqual([])
    } finally {
      await f.cleanup()
    }
  })

  test('real Worker VM rewrites full-pipeline inputs and preserves unchanged mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-tool-integration-'))
    const runtime = createModsRuntime()
    try {
      const entry = join(root, 'register.ts')
      await writeFile(
        entry,
        `export function register(on) { on('tool.call', async ($, e, next) => { const r = await next({ ...e, value: 'worker rewritten' }); return { ...r, result: { value: r.result.value } }; }); }`,
      )
      await runtime.reconcile([
        {
          name: 'tool-fixture',
          storageId: 'tool-fixture',
          pluginRoot: root,
          entrypoints: [entry],
        },
      ])
      expect(runtime.hasHooks('tool.call')).toBe(true)
      const f = fixture(async (e, next) => next(e))
      f.context.mods = runtime
      let mapped = 0
      f.tool.mapToolResultToToolResultBlockParam = (value, id) => {
        mapped++
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: (value as { value: string }).value,
        }
      }
      await Array.fromAsync(
        runToolUse(
          f.block,
          f.assistant,
          async () => ({ behavior: 'allow' }),
          f.context,
        ),
      )
      expect(f.calls).toEqual([{ value: 'worker rewritten' }])
      expect(mapped).toBe(1)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Agent retains the executor snapshot for dispatch admission', async () => {
    const f = fixture(async (event, next) => next(event), AGENT_TOOL_NAME)
    const received: unknown[] = []
    f.tool.call = async (input, context) => {
      received.push(context.modsSnapshot)
      return { data: input }
    }
    await Array.fromAsync(runToolUse(
      f.block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    ))
    expect(received).toHaveLength(1)
    expect(received[0]).toBeDefined()
    expect(f.releases()).toBe(1)
  })

  test('background-capable tools do not retain the executor snapshot', async () => {
    const f = fixture(async (event, next) => next(event))
    const received: unknown[] = []
    f.tool.call = async (input, context) => {
      received.push(context.modsSnapshot)
      return { data: input }
    }
    await Array.fromAsync(runToolUse(
      f.block, f.assistant, async () => ({ behavior: 'allow' }), f.context,
    ))
    expect(received).toEqual([undefined])
    expect(f.releases()).toBe(1)
  })

  test('persists the final transformed result rather than the discarded raw branch', async () => {
    const f = fixture(async (e, next) => {
      await next(e)
      return { result: { value: 'transformed '.repeat(1000) } }
    })
    f.block.id = `mods-persistence-${crypto.randomUUID()}`
    f.tool.maxResultSizeChars = 20
    f.tool.call = async () => ({ data: { value: 'original '.repeat(1000) } })
    const path = getToolResultPath(f.block.id, false)
    try {
      const updates = await Array.fromAsync(
        runToolUse(
          f.block,
          f.assistant,
          async () => ({ behavior: 'allow' }),
          f.context,
        ),
      )
      expect(JSON.stringify(updates)).toContain('<persisted-output>')
      expect(await readFile(path, 'utf8')).toBe('transformed '.repeat(1000))
    } finally {
      await rm(path, { force: true })
    }
  })

  test('each explicit next executes the complete real pipeline again; recovery does not', async () => {
    const f = fixture(async (e, next) => {
      await next({ ...e, value: 'first' })
      await next({ ...e, value: 'second' })
      throw new Error('recover last')
    })
    let permissions = 0
    const updates = await Array.fromAsync(
      runToolUse(
        f.block,
        f.assistant,
        async (_tool, input) => {
          permissions++
          return { behavior: 'allow', updatedInput: input }
        },
        f.context,
      ),
    )
    expect(f.calls).toEqual([{ value: 'first' }, { value: 'second' }])
    expect(permissions).toBe(2)
    expect(f.validation).toHaveLength(2)
    expect(JSON.stringify(updates)).toContain('second')
    expect(f.releases()).toBe(1)
  })
})
