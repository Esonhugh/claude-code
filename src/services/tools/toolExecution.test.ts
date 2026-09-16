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
import { getToolResultPath } from '../../utils/toolResultStorage.js'

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

function fixture(invoke: ModDispatchHook['invoke']) {
  const calls: unknown[] = []
  const validation: unknown[] = []
  let releases = 0
  const hooks = new Map()
  const tool = {
    name: 'ModFixture',
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
    hasHooks: () => true,
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
            registration: { id: 1, event, hasCatch: false },
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

describe('Mods at the whole tool execution boundary', () => {
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
    const f = fixture(async (e, next) => {
      void next(e)
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
