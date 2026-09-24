import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { z } from 'zod/v4'
import { runToolUse } from './toolExecution.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  clearRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
  getIsInteractive,
} from '../../bootstrap/state.js'
import { resetHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import type { SettingsJson as Settings } from '../../utils/settings/types.js'
import { createModsRuntime } from '../mods/runtime.js'
import { seatNativeModPlugins } from '../mods/native.js'
import { loadModDeclaration } from '../mods/loader.js'
import { runTools } from './toolOrchestration.js'
import { StreamingToolExecutor } from './StreamingToolExecutor.js'
import { dispatchModEvent } from '../mods/dispatch.js'
import type { ModDispatchHook } from '../mods/types.js'
import {
  checkModToolPermission,
  modToolCheckResult,
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
} from './toolHooks.js'

const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']
let home: string
let savedEnv: (string | undefined)[]
let interactive: boolean
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'classic-tool-boundary-'))
  savedEnv = envKeys.map(key => process.env[key])
  envKeys.forEach(key => {
    process.env[key] = home
  })
  interactive = getIsInteractive()
  setIsInteractive(false)
  clearRegisteredHooks()
  configure()
})
afterEach(() => {
  clearRegisteredHooks()
  resetHooksConfigSnapshot()
  resetSettingsCache()
  setIsInteractive(interactive)
  envKeys.forEach((key, i) => {
    if (savedEnv[i] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[i]
  })
  rmSync(home, { recursive: true, force: true })
})
function configure(policy: Settings = {}, user: Settings = {}) {
  resetSettingsCache()
  resetHooksConfigSnapshot()
  setSessionSettingsCache({ settings: user, errors: [] })
  for (const source of [
    'policySettings',
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
  ] as const)
    setCachedSettingsForSource(
      source,
      source === 'policySettings'
        ? policy
        : source === 'userSettings'
          ? user
          : {},
    )
}
function fixture(invoke?: ModDispatchHook['invoke']) {
  const events: string[] = []
  let captures = 0
  let releases = 0
  const tool = {
    name: 'ClassicFixture',
    inputSchema: z.object({ value: z.string() }),
    getToolUseSummary: () => 'fixture summary',
  } as unknown as Tool
  const context = {
    options: { tools: [tool], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionHooks: new Map(),
    }),
    ...(invoke
      ? {
          mods: {
            capture: () => {
              captures++
              return {
                release: () => {
                  releases++
                },
                hasHooks: () => true,
                dispatch: (
                  event: string,
                  input: Record<string, unknown>,
                  core: (input: Record<string, unknown>) => Promise<unknown>,
                  options: object,
                ) => {
                  events.push(event)
                  return dispatchModEvent({
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
                  })
                },
              }
            },
          },
        }
      : {}),
  } as unknown as ToolUseContext
  return {
    context,
    tool,
    events,
    captures: () => captures,
    releases: () => releases,
  }
}
function pre(f: ReturnType<typeof fixture>) {
  return runPreToolUseHooks(
    f.context,
    f.tool,
    { value: 'original' },
    'tool-id',
    'message-id',
    undefined,
    undefined,
    undefined,
  )
}
describe('declarative tool permission projection', () => {
  test('probes the tool once and retains its updated input without running hooks', async () => {
    const f = fixture()
    let probes = 0
    f.tool.checkPermissions = async () => {
      probes++
      return { behavior: 'allow', updatedInput: { value: 'normalized' } }
    }
    const decision = await checkModToolPermission(f.tool, { value: 'original' }, f.context)
    expect(probes).toBe(1)
    expect(decision).toMatchObject({ behavior: 'allow', updatedInput: { value: 'normalized' } })
    expect(modToolCheckResult(decision)).toEqual({ decision: 'allow' })
    expect(f.events).toEqual([])
  })

  test('classic capture injects the current tool host alongside the catalog', async () => {
    const f = fixture()
    f.tool.checkPermissions = async () => ({ behavior: 'allow' })
    let services: Parameters<ReturnType<typeof createModsRuntime>['capture']>[0]
    f.context.mods = {
      tools: { projection: (tools: Tool[]) => tools },
      capture: (captured: typeof services) => {
        services = captured
        return { hasHooks: () => false, release: () => {} }
      },
    } as unknown as NonNullable<ToolUseContext['mods']>
    await Array.fromAsync(pre(f))
    expect(services?.toolCatalog).toBeFunction()
    const host = services?.toolHost?.()
    expect(host?.tools?.()).toEqual([f.tool])
    expect(await host?.check({ tool: f.tool.name, input: { value: 'check' } }, f.context.abortController.signal)).toEqual({ decision: 'allow' })
  })
})

function command(output: unknown) {
  return {
    type: 'command' as const,
    command: `printf '%s' '${JSON.stringify(output)}'`,
  }
}
function contexts(results: Awaited<ReturnType<typeof Array.fromAsync>>) {
  return (results as any[]).flatMap(result => {
    const message = result.message?.message ?? result.message
    return message?.attachment?.type === 'hook_additional_context'
      ? message.attachment.content
      : []
  })
}

describe('classic events at existing tool hook boundaries', () => {
  test('module short circuit skips the non-managed callback, with one capture/release', async () => {
    let executed = 0
    registerHookCallbacks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                executed++
                return {}
              },
            },
          ],
        },
      ],
    })
    const f = fixture(async () => ({
      deny: 'module refused',
      additionalContext: ['module'],
    }))
    const results = await Array.fromAsync(pre(f))
    expect(executed).toBe(0)
    expect(f.events).toEqual(['classic.PreToolUse'])
    expect(f.captures()).toBe(1)
    expect(f.releases()).toBe(1)
    expect(
      results
        .filter(r => r.type === 'hookPermissionResult')
        .map(r => r.hookPermissionResult.behavior),
    ).toEqual(['deny'])
    expect(contexts(results)).toEqual(['module'])
  })

  test('identical real commands in managed and user sources each run exactly once around modules', async () => {
    const marker = join(home, 'runs')
    const hook = {
      type: 'command' as const,
      command: `printf x >> '${marker}'; printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'same' } })}'`,
    }
    const settings = { hooks: { PreToolUse: [{ hooks: [hook] }] } }
    configure(settings, settings)
    let observedRuns = ''
    const f = fixture(async (e, next) => {
      observedRuns = readFileSync(marker, 'utf8')
      return next(e)
    })
    const results = await Array.fromAsync(pre(f))
    expect(observedRuns).toBe('x')
    expect(readFileSync(marker, 'utf8')).toBe('xx')
    expect(contexts(results)).toEqual(['same', 'same'])
  })

  test('equal decision text retains the latest winning source rather than the first matching reason', async () => {
    configure({}, { hooks: { PreToolUse: [{ hooks: [command({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'same reason' } })] }] } })
    registerHookCallbacks({ PreToolUse: [{ hooks: [{ type: 'callback', callback: async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'same reason' } }) }] }] })
    const f = fixture(async (e, next) => next(e))
    const results = await Array.fromAsync(pre(f))
    expect(results.find(r => r.type === 'hookPermissionResult')?.hookPermissionResult).toMatchObject({ behavior: 'ask', decisionReason: { hookSource: 'userSettings' } })
  })

  test('managed command deny prevents modules and non-managed callback execution', async () => {
    configure({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              command({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'policy refusal',
                },
              }),
            ],
          },
        ],
      },
    })
    let modules = 0
    let executed = 0
    registerHookCallbacks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                executed++
                return {}
              },
            },
          ],
        },
      ],
    })
    const f = fixture(async (_e, next) => {
      modules++
      return next(_e)
    })
    const results = await Array.fromAsync(pre(f))
    expect(modules).toBe(0)
    expect(executed).toBe(0)
    expect(
      results.find(r => r.type === 'hookPermissionResult')
        ?.hookPermissionResult,
    ).toMatchObject({
      behavior: 'deny',
      message: 'policy refusal',
      decisionReason: { hookSource: 'policySettings' },
    })
  })

  test('managed allow does not authorize a later classic output rewrite', async () => {
    configure({hooks:{PreToolUse:[{hooks:[command({hookSpecificOutput:{
      hookEventName:'PreToolUse', permissionDecision:'allow',
    }})]}]}})
    const f = fixture(async () => ({updatedInput:{value:'not reviewed'}}))
    const results = await Array.fromAsync(pre(f))
    expect(results.some(r => r.type === 'hookPermissionResult' && r.hookPermissionResult.behavior === 'allow')).toBe(false)
    expect(results.find(r => r.type === 'hookUpdatedInput')).toMatchObject({updatedInput:{value:'not reviewed'}})
  })

  test('managed pre rechecks classic next rewrites at the core boundary', async () => {
    const marker = join(home, 'classic-rewrites')
    configure({hooks:{PreToolUse:[{hooks:[{type:'command', command:`cat >> '${marker}'`}]}]}})
    const f = fixture(async (e, next) => next({...e,value:'classic rewrite'}))
    await Array.fromAsync(pre(f))
    expect(readFileSync(marker,'utf8').trim().split('\n').map(line => JSON.parse(line).tool_input.value)).toEqual(['original','classic rewrite'])
  })

  test('managed pre rewrites feed classic dispatch', async () => {
    configure({hooks:{PreToolUse:[{hooks:[command({hookSpecificOutput:{
      hookEventName:'PreToolUse', updatedInput:{value:'managed input'},
    }})]}]}})
    let seen: unknown
    const f = fixture(async (e, next) => {
      seen = e.value
      return next(e)
    })
    const results = await Array.fromAsync(pre(f))
    expect(seen).toBe('managed input')
    expect(results.find(r => r.type === 'hookUpdatedInput')).toMatchObject({updatedInput:{value:'managed input'}})
  })

  test('next executes SDK callback once, preserves progress and folds duplicate contexts once', async () => {
    let executed = 0
    registerHookCallbacks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                executed++
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: 'confirm',
                    updatedInput: { value: 'changed' },
                    additionalContext: 'same',
                  },
                }
              },
            },
          ],
        },
      ],
    })
    const f = fixture(async (e, next) => {
      const answer = (await next(e)) as Record<string, unknown>
      return {
        ...answer,
        additionalContext: [...(answer.additionalContext as string[]), 'same'],
      }
    })
    const results = await Array.fromAsync(pre(f))
    expect(executed).toBe(1)
    expect(contexts(results)).toEqual(['same', 'same'])
    expect(results.filter(r => r.type === 'hookPermissionResult')).toHaveLength(
      1,
    )
    expect(
      results.find(r => r.type === 'hookPermissionResult')
        ?.hookPermissionResult,
    ).toMatchObject({
      behavior: 'ask',
      updatedInput: { value: 'changed' },
      message: 'confirm',
      decisionReason: { hookSource: 'sdk' },
    })
    expect(
      results.some(
        r => r.type === 'message' && r.message.message.type === 'progress',
      ),
    ).toBe(true)
  })

  test.each([null, false, 0, ''])(
    'PostToolUse keeps falsy MCP output %p and consumes context once',
    async replacement => {
      let executed = 0
      registerHookCallbacks({
        PostToolUse: [
          {
            hooks: [
              {
                type: 'callback',
                callback: async () => {
                  executed++
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PostToolUse',
                      updatedMCPToolOutput: replacement,
                      additionalContext: 'post',
                    },
                  }
                },
              },
            ],
          },
        ],
      })
      const f = fixture(async (e, next) => next(e))
      f.tool.isMcp = true
      const results = await Array.fromAsync(
        runPostToolUseHooks(
          f.context,
          f.tool,
          'id',
          'message',
          {},
          'old',
          undefined,
          undefined,
          undefined,
        ),
      )
      expect(executed).toBe(1)
      expect(f.events).toEqual(['classic.PostToolUse'])
      expect(results.filter(r => 'updatedToolOutput' in r)).toEqual([
        { updatedToolOutput: replacement },
      ])
      expect(contexts(results)).toEqual(['post'])
    },
  )

  test.each([null, false, 0, ''])(
    'PostToolUse returns falsy general output rewrite %p for regular tools',
    async replacement => {
      registerHookCallbacks({
        PostToolUse: [{ hooks: [{
          type: 'callback',
          callback: async () => ({ hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            updatedToolOutput: replacement,
            additionalContext: 'post',
          } }),
        }] }],
      })
      const f = fixture(async (e, next) => next(e))
      const results = await Array.fromAsync(runPostToolUseHooks(
        f.context, f.tool, 'id', 'message', {}, { value: 'old' },
        undefined, undefined, undefined,
      ))
      expect(results.filter(r => 'updatedToolOutput' in r)).toEqual([
        { updatedToolOutput: replacement },
      ])
      expect(contexts(results)).toEqual(['post'])
    },
  )

  test('regular tool output rewrites become the transcript and model result', async () => {
    registerHookCallbacks({
      PostToolUse: [{ hooks: [{
        type: 'callback',
        callback: async () => ({ hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: { value: 'reviewed' },
          additionalContext: 'after output',
        } }),
      }] }],
    })
    const f = fixture()
    Object.assign(f.tool, {
      outputSchema: z.object({ value: z.string() }),
      maxResultSizeChars: Infinity,
      isConcurrencySafe: () => true,
      validateInput: async () => ({ result: true }),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => ({ data: { value: 'raw' } }),
      mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) =>
        ({ type: 'tool_result', tool_use_id: id, content: data.value }),
    })
    Object.assign(f.context, { setAppState: () => {}, setInProgressToolUseIDs: () => {} })
    f.context.options.mcpClients = []
    const block = { type: 'tool_use' as const, caller: { type: 'direct' as const }, id: 'regular-rewrite', name: f.tool.name, input: { value: 'original' } }
    const updates = await Array.fromAsync(runToolUse(block, createAssistantMessage({ content: [block] }), async () => ({ behavior: 'allow' }), f.context))
    const messages = updates.flatMap(update => update.message.type === 'user' ? [update.message] : [])
    const results = messages.flatMap(message => Array.isArray(message.message.content) ? message.message.content.filter(block => block.type === 'tool_result') : [])
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toBe('reviewed')
    expect(messages.find(message => message.toolUseResult)?.toolUseResult).toEqual({ value: 'reviewed' })
    expect(JSON.stringify(updates)).not.toContain('\"content\":\"raw\"')
  })

  test('invalid regular output rewrites keep the original result and report the hook error', async () => {
    registerHookCallbacks({ PostToolUse: [{ hooks: [{
      type: 'callback', callback: async () => ({ hookSpecificOutput: {
        hookEventName: 'PostToolUse', updatedToolOutput: { invalid: true },
      } }),
    }] }] })
    const f = fixture()
    Object.assign(f.tool, {
      outputSchema: z.object({ value: z.string() }),
      maxResultSizeChars: Infinity,
      isConcurrencySafe: () => true,
      validateInput: async () => ({ result: true }),
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => ({ data: { value: 'raw' } }),
      mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) =>
        ({ type: 'tool_result', tool_use_id: id, content: data.value }),
    })
    Object.assign(f.context, { setAppState: () => {}, setInProgressToolUseIDs: () => {} })
    f.context.options.mcpClients = []
    const block = { type: 'tool_use' as const, caller: { type: 'direct' as const }, id: 'invalid-rewrite', name: f.tool.name, input: { value: 'original' } }
    const updates = await Array.fromAsync(runToolUse(block, createAssistantMessage({ content: [block] }), async () => ({ behavior: 'allow' }), f.context))
    expect(JSON.stringify(updates)).toContain('\"content\":\"raw\"')
    expect(JSON.stringify(updates)).toContain('does not match ClassicFixture')
    expect(JSON.stringify(updates)).not.toContain('\"invalid\":true')
  })

  test('PostToolUseFailure dispatches once, not a second execution after the callback', async () => {
    let executed = 0
    registerHookCallbacks({
      PostToolUseFailure: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                executed++
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUseFailure',
                    additionalContext: 'failure',
                  },
                }
              },
            },
          ],
        },
      ],
    })
    const f = fixture(async (e, next) => next(e))
    const results = await Array.fromAsync(
      runPostToolUseFailureHooks(
        f.context,
        f.tool,
        'id',
        'message',
        {},
        'failed',
        false,
        undefined,
        undefined,
        undefined,
      ),
    )
    expect(f.events).toEqual(['classic.PostToolUseFailure'])
    expect(executed).toBe(1)
    expect(contexts(results)).toEqual(['failure'])
  })

  test('PostToolUse stop retains its folded context exactly once', async () => {
    const f = fixture(async () => ({
      preventContinuation: true,
      stopReason: 'stop',
      additionalContext: ['before stop', 'before stop'],
    }))
    const results = await Array.fromAsync(
      runPostToolUseHooks(
        f.context,
        f.tool,
        'id',
        'message',
        {},
        'old',
        undefined,
        undefined,
        undefined,
      ),
    )
    expect(contexts(results)).toEqual(['before stop', 'before stop'])
    expect(
      results.filter(
        r =>
          'message' in r &&
          r.message.type === 'attachment' &&
          r.message.attachment.type === 'hook_stopped_continuation',
      ),
    ).toHaveLength(1)
  })

  test('managed ask outranks module allow, retains source and ordered duplicate contexts', async () => {
    configure({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              command({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'ask',
                  permissionDecisionReason: 'policy confirm',
                  additionalContext: 'same',
                },
              }),
            ],
          },
        ],
      },
    })
    const f = fixture(async () => ({
      allow: true,
      additionalContext: ['same', 'module'],
    }))
    const results = await Array.fromAsync(pre(f))
    expect(contexts(results)).toEqual(['same', 'same', 'module'])
    expect(
      results.find(r => r.type === 'hookPermissionResult')
        ?.hookPermissionResult,
    ).toMatchObject({
      behavior: 'ask',
      message: 'policy confirm',
      decisionReason: { hookSource: 'policySettings' },
    })
  })

  test('raw PreToolUse stop survives a module replacing the folded deny', async () => {
    registerHookCallbacks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => ({
                continue: false,
                stopReason: 'stop host',
              }),
            },
          ],
        },
      ],
    })
    const f = fixture(async (e, next) => {
      await next(e)
      return { allow: true }
    })
    const results = await Array.fromAsync(pre(f))
    expect(results.filter(r => r.type === 'preventContinuation')).toEqual([
      { type: 'preventContinuation', shouldPreventContinuation: true },
    ])
    expect(results.filter(r => r.type === 'stopReason')).toEqual([
      { type: 'stopReason', stopReason: 'stop host' },
    ])
    expect(
      results.find(r => r.type === 'hookPermissionResult')
        ?.hookPermissionResult,
    ).toMatchObject({ behavior: 'deny', message: 'stop host' })
  })

  test('unawaited next settles before the final decision and does not duplicate contexts', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    registerHookCallbacks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                await gate
                return {
                  continue: false,
                  stopReason: 'late stop',
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    additionalContext: 'discarded fold',
                  },
                }
              },
            },
          ],
        },
      ],
    })
    const f = fixture(async (e, next) => {
      void next(e)
      return { allow: true }
    })
    const generator = pre(f)
    try {
      const progress = await generator.next()
      expect(progress.value?.type).toBe('message')
    } finally {
      release()
    }
    const results = await Array.fromAsync(generator)
    expect(
      results.find(r => r.type === 'hookPermissionResult')?.hookPermissionResult
        .behavior,
    ).toBe('deny')
    expect(contexts(results)).toEqual([])
    expect(f.releases()).toBe(1)
  })

  test('PostToolUseFailure stop is retained as a host attachment', async () => {
    const f = fixture(async () => ({
      preventContinuation: true,
      stopReason: 'failure stop',
    }))
    const results = await Array.fromAsync(
      runPostToolUseFailureHooks(
        f.context,
        f.tool,
        'id',
        'message',
        {},
        'failed',
        false,
        undefined,
        undefined,
        undefined,
      ),
    )
    expect(
      results.some(
        r =>
          r.message.type === 'attachment' &&
          r.message.attachment.type === 'hook_stopped_continuation',
      ),
    ).toBe(true)
  })

  test('PostToolUse delivers progress before a pending hook finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    registerHookCallbacks({
      PostToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                await gate
                return {}
              },
            },
          ],
        },
      ],
    })
    const f = fixture(async (e, next) => next(e))
    const stream = runPostToolUseHooks(
      f.context,
      f.tool,
      'id',
      'message',
      {},
      'old',
      undefined,
      undefined,
      undefined,
    )
    try {
      const first = await stream.next()
      expect(first.done).toBe(false)
      expect('message' in first.value! && first.value.message.type).toBe(
        'progress',
      )
    } finally {
      release()
    }
    await Array.fromAsync(stream)
    expect(f.releases()).toBe(1)
  })

  test('module input rewrites are returned to the existing validation and permission owner', async () => {
    const f = fixture(async () => ({
      allow: true,
      updatedInput: { value: 42 },
    }))
    const results = await Array.fromAsync(pre(f))
    // The boundary must reject invalid module rewrites, rather than handing an
    // unvalidated value to the downstream permission owner or Tool.call.
    expect(
      results.some(
        r =>
          r.type === 'hookPermissionResult' &&
          r.hookPermissionResult.behavior === 'allow',
      ),
    ).toBe(false)
  })

  test('the real tool pipeline validates a classic rewrite before its single permission owner and Tool.call', async () => {
    const order: string[] = []
    const f = fixture(async (e, next) => {
      if ('tool' in e)
        return { allow: true, updatedInput: { value: 'rewritten' } }
      return next(e)
    })
    // Pin an already-owned snapshot, as the parent tool boundary may do. Only
    // classic events are registered; tool.call is not wrapped by this fixture.
    const snapshot = f.context.mods!.capture()
    f.context.modsSnapshot = {
      ...snapshot,
      hasHooks: event => event.startsWith('classic.'),
    }
    Object.assign(f.tool, {
      isConcurrencySafe: () => true,
      maxResultSizeChars: Infinity,
      validateInput: async (input: { value: string }) => {
        order.push(`validate:${input.value}`)
        return { result: true }
      },
      call: async (input: { value: string }) => {
        order.push(`call:${input.value}`)
        return { data: input }
      },
      mapToolResultToToolResultBlockParam: (
        data: { value: string },
        id: string,
      ) => ({ type: 'tool_result', tool_use_id: id, content: data.value }),
    })
    f.context.options.mcpClients = []
    f.context.setAppState = () => {}
    f.context.setInProgressToolUseIDs = () => {}
    const block = {
      type: 'tool_use' as const,
      caller: { type: 'direct' as const },
      id: 'tool-id',
      name: f.tool.name,
      input: { value: 'original' },
    }
    const assistant = createAssistantMessage({ content: [block] })
    await Array.fromAsync(
      runToolUse(
        block,
        assistant,
        async (_tool, input) => {
          order.push(`permission:${input.value}`)
          return { behavior: 'allow', updatedInput: input }
        },
        { ...f.context, requireCanUseTool: true },
      ),
    )
    expect(order).toEqual([
      'validate:original',
      'validate:rewritten',
      'permission:rewritten',
      'call:rewritten',
    ])
    expect(f.events).toEqual(['classic.PreToolUse', 'classic.PostToolUse'])
    expect(f.releases()).toBe(0)
    snapshot.release()
  })

  test.each(['synthetic', 'transformed', 'failed', 'denied', 'deny-after'] as const)(
    'managed final review cannot be skipped for %s Worker results', async mode => {
      const marker = join(home, 'managed-final')
      const post = (event: 'PostToolUse' | 'PostToolUseFailure') => ({hooks:[{
        type:'command' as const,
        command:`cat >> '${marker}'; printf '%s' '${JSON.stringify({hookSpecificOutput:{hookEventName:event, additionalContext:'managed final review'}})}'`,
      }]})
      configure({hooks:{PostToolUse:[post('PostToolUse')], PostToolUseFailure:[post('PostToolUseFailure')]}})
      const entry = join(home, 'register.ts')
      writeFileSync(entry, `export function register(on) {
        on('tool.call', async ($, e, next) => {
          ${mode === 'transformed' || mode === 'failed' || mode === 'deny-after' ? 'await next(e);' : ''}
          return ${mode === 'denied' || mode === 'deny-after' ? "{deny:'module refused'}" : "{result:{value:'final value'}}"};
        });
        on('classic.PostToolUse', () => ({}));
        on('classic.PostToolUseFailure', () => ({}));
      }`)
      const runtime = createModsRuntime()
      try {
        await runtime.reconcile([{name:'final-fixture', storageId:'final-fixture@inline', pluginRoot:home, entrypoints:[entry]}])
        const f = fixture()
        let calls = 0
        Object.assign(f.tool, {
          outputSchema:z.object({value:z.string()}), maxResultSizeChars:Infinity,
          call:async () => { calls++; if (mode === 'failed') throw Error('actual failure'); return {data:{value:'raw value'}} },
          mapToolResultToToolResultBlockParam:(data:{value:string}, id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
        })
        Object.assign(f.context, {mods:runtime, setAppState:() => {}, setInProgressToolUseIDs:() => {}})
        f.context.options.mcpClients = []
        const block = {type:'tool_use' as const, caller:{type:'direct' as const}, id:'managed-final-id',name:f.tool.name,input:{value:'original'}}
        const updates = await Array.fromAsync(runToolUse(block, createAssistantMessage({content:[block]}), async () => ({behavior:'allow'}), f.context))
        const result = updates.flatMap(update =>
          update.message.type === 'user' && Array.isArray(update.message.message.content)
            ? update.message.message.content.filter(item => item.type === 'tool_result')
            : [],
        )
        expect(result).toHaveLength(1)
        if (mode === 'failed' || mode === 'denied' || mode === 'deny-after') {
          expect(result[0]!.is_error).toBe(true)
          expect(result[0]!.content).toContain(mode === 'failed' ? 'actual failure' : 'module refused')
        } else {
          expect(result[0]!.is_error).not.toBe(true)
          expect(result[0]!.content).toBe('final value')
        }
        // Official no-next deny is not a failed tool execution.
        if (mode === 'denied') {
          expect(contexts(updates)).toEqual([])
          expect(calls).toBe(0)
          return
        }
        expect(contexts(updates)).toEqual(['managed final review'])
        const observations = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(observations).toHaveLength(1)
        if (mode === 'failed') {
          expect(observations[0].hook_event_name).toBe('PostToolUseFailure')
          expect(observations[0].error).toContain('actual failure')
        } else {
          expect(observations[0].hook_event_name).toBe('PostToolUse')
          expect(observations[0].tool_response).toEqual({value:mode === 'deny-after' ? 'raw value' : 'final value'})
        }
        expect(calls).toBe(mode === 'transformed' || mode === 'failed' || mode === 'deny-after' ? 1 : 0)
      } finally { await runtime.dispose() }
    },
  )

  test('managed ask and rewritten input reach permission checks despite a Worker classic allow', async () => {
    const marker = join(home, 'managed-ask')
    configure({ hooks: { PreToolUse: [{ hooks: [{
      type: 'command',
      command: `cat >> '${marker}'; printf '%s' '${JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'ask',
        permissionDecisionReason: 'managed confirmation',
        updatedInput: { value: 'managed input' }, additionalContext: 'managed context',
      } })}'`,
    }] }] } })
    const entry = join(home, 'register.ts')
    writeFileSync(entry, `export function register(on) {
      on('tool.call', ($, e, next) => {
        if (e.value !== 'managed input') throw Error('outer rewrite missing');
        return next(e);
      });
      on('classic.PreToolUse', () => ({allow:true}));
    }`)
    const runtime = createModsRuntime()
    try {
      await runtime.reconcile([{name:'managed-ask',storageId:'managed-ask@inline',pluginRoot:home,entrypoints:[entry]}])
      const f = fixture()
      const calls: unknown[] = []
      const permissions: unknown[] = []
      Object.assign(f.tool, {
        outputSchema: z.object({value:z.string()}), maxResultSizeChars: Infinity,
        call: async (input: unknown) => { calls.push(input); return {data:input} },
        mapToolResultToToolResultBlockParam: (data:{value:string},id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
      })
      Object.assign(f.context, {mods:runtime,setAppState:() => {},setInProgressToolUseIDs:() => {}})
      f.context.options.mcpClients = []
      const block = {type:'tool_use' as const,caller:{type:'direct' as const},id:'managed-ask',name:f.tool.name,input:{value:'original'}}
      const updates = await Array.fromAsync(runToolUse(block,createAssistantMessage({content:[block]}),async (_tool,input,_context,_assistant,_id,forceDecision) => {
        permissions.push({input,forceDecision})
        return {behavior:'allow'}
      },f.context))
      expect(readFileSync(marker,'utf8').trim().split('\n').map(line => JSON.parse(line).tool_input)).toEqual([{value:'original'}])
      expect(permissions).toHaveLength(1)
      expect(permissions[0]).toMatchObject({input:{value:'managed input'},forceDecision:{
        behavior:'ask',message:'managed confirmation',decisionReason:{hookSource:'policySettings'},
      }})
      expect(calls).toEqual([{value:'managed input'}])
      expect(contexts(updates)).toEqual(['managed context'])
      expect(JSON.stringify(updates)).not.toContain('outer rewrite missing')
    } finally { await runtime.dispose() }
  })

  test('cancellation after managed pre cannot deliver synthetic success or replay core', async () => {
    const marker=join(home,'cancel-pre')
    configure({hooks:{PreToolUse:[{hooks:[{type:'command',command:`printf x >> '${marker}'`}]}]}})
    const f=fixture(async () => {
      f.context.abortController.abort(new Error('fixture cancelled'))
      return {result:{value:'must not deliver'}}
    })
    let calls=0
    Object.assign(f.tool,{outputSchema:z.object({value:z.string()}),maxResultSizeChars:Infinity,
      call:async () => {calls++;return {data:{value:'raw'}}},
      mapToolResultToToolResultBlockParam:(data:{value:string},id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
    })
    Object.assign(f.context,{setAppState:() => {},setInProgressToolUseIDs:() => {}})
    f.context.options.mcpClients=[]
    const block={type:'tool_use' as const,caller:{type:'direct' as const},id:'cancel-pre',name:f.tool.name,input:{value:'original'}}
    const updates=await Array.fromAsync(runToolUse(block,createAssistantMessage({content:[block]}),async () => ({behavior:'allow'}),f.context))
    expect(readFileSync(marker,'utf8')).toBe('x')
    expect(calls).toBe(0)
    expect(f.releases()).toBe(1)
    expect(JSON.stringify(updates)).not.toContain('must not deliver')
    expect(JSON.stringify(updates)).toContain('fixture cancelled')
  })

  test('managed post reviews additive synthetic context and retains stop/block after short circuit', async () => {
    const marker=join(home,'context-review')
    configure({hooks:{PostToolUse:[{hooks:[{type:'command',command:`cat >> '${marker}'; printf '%s' '${JSON.stringify({decision:'block',reason:'managed block',continue:false,stopReason:'managed stop'})}'`}]}]}})
    const entry=join(home,'register.ts')
    writeFileSync(entry,`export function register(on) {on('tool.call',() => ({result:{value:'synthetic'},context:['extra']}));}`)
    const runtime=createModsRuntime()
    try {
      await runtime.reconcile([{name:'context-review',storageId:'context-review@inline',pluginRoot:home,entrypoints:[entry]}])
      const f=fixture()
      Object.assign(f.tool,{outputSchema:z.object({value:z.string()}),maxResultSizeChars:Infinity,
        call:async () => {throw Error('must not execute')},
        mapToolResultToToolResultBlockParam:(data:{value:string},id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
      })
      Object.assign(f.context,{mods:runtime,setAppState:() => {},setInProgressToolUseIDs:() => {}})
      f.context.options.mcpClients=[]
      const block={type:'tool_use' as const,caller:{type:'direct' as const},id:'context-review',name:f.tool.name,input:{value:'original'}}
      const updates=await Array.fromAsync(runToolUse(block,createAssistantMessage({content:[block]}),async () => ({behavior:'allow'}),f.context))
      expect(readFileSync(marker,'utf8').trim().split('\n').map(line => JSON.parse(line).tool_response)).toEqual([{value:'synthetic'},['extra']])
      expect(contexts(updates)).toEqual([])
      expect(JSON.stringify(updates)).toContain('managed block')
      expect(JSON.stringify(updates)).toContain('managed stop')
    } finally {await runtime.dispose()}
  })

  test('managed outer review observes MCP output after non-managed classic rewriting', async () => {
    const marker = join(home, 'mcp-review')
    configure({hooks:{PostToolUse:[{hooks:[{type:'command',command:`cat >> '${marker}'`}]}]}})
    registerHookCallbacks({PostToolUse:[{hooks:[{type:'callback',callback:async () => ({hookSpecificOutput:{
      hookEventName:'PostToolUse',updatedMCPToolOutput:{value:'classic output'},
    }})}]}]})
    const f = fixture((e,next) => next(e))
    Object.assign(f.tool,{
      isMcp:true,outputSchema:z.object({value:z.string()}),maxResultSizeChars:Infinity,
      call:async () => ({data:{value:'raw'}}),
      mapToolResultToToolResultBlockParam:(data:{value:string},id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
    })
    Object.assign(f.context,{setAppState:() => {},setInProgressToolUseIDs:() => {}})
    f.context.options.mcpClients=[]
    const block={type:'tool_use' as const,caller:{type:'direct' as const},id:'mcp-reviewed',name:f.tool.name,input:{value:'original'}}
    const updates=await Array.fromAsync(runToolUse(block,createAssistantMessage({content:[block]}),async () => ({behavior:'allow'}),f.context))
    expect(JSON.stringify(updates)).toContain('classic output')
    expect(JSON.parse(readFileSync(marker,'utf8')).tool_response).toEqual({value:'classic output'})
  })

  for (const implementation of ['local', 'official'] as const) {
    test.skipIf(implementation === 'official' && !process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE)(
      `${implementation} native policy protects both schedulers with repeatable next, ref and child result omission`, async () => {
        const marker = join(home, 'scheduler-policy')
        const policy: Settings = {hooks:Object.fromEntries(['PreToolUse','PostToolUse'].map(event => [event,[{hooks:[{
          type:'command', command:`cat >> '${marker}'`,
        }]}]]))}
        configure(policy)
        const entry = join(home, 'register.ts')
        writeFileSync(entry, `export function register(on) {
          on('tool.call', async ($, e, next) => {
            const first = await next(e);
            await next(e);
            await next({...e,value:'second'});
            return first;
          });
          on('classic.PreToolUse', () => ({deny:'user classic must be skipped'}));
          on('classic.PostToolUse', () => ({block:'user classic must be skipped'}));
        }`)
        const officialRoot = process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE
        const official = implementation === 'official' ? await loadModDeclaration({
          name:'sec-default', storageId:'sec-default@inline',
          pluginRoot:join(officialRoot!,'sec-default'),
          entrypoints:[join(officialRoot!,'sec-default/hooks/register.ts')],
        }) : undefined
        const runtime = createModsRuntime()
        try {
          await runtime.reconcile(seatNativeModPlugins([{
            name:'scheduler-policy', storageId:'scheduler-policy@inline',pluginRoot:home,entrypoints:[entry],
          }], {userSettings:null,flagSettings:null,policySettings:policy,hookPolicy:{managedOnly:false,allDisabled:false}},official))
          for (const streaming of [false,true]) {
            writeFileSync(marker,'')
            const f = fixture()
            const calls: string[] = []
            const permissions: string[] = []
            let modifiers = 0
            Object.assign(f.tool, {
              inputSchema:z.object({value:z.string()}),outputSchema:z.object({value:z.string()}),
              maxResultSizeChars:Infinity,isConcurrencySafe:() => true,
              call:async (input:{value:string}) => {calls.push(input.value); return {data:input,contextModifier:(ctx:ToolUseContext) => {modifiers++;return ctx}}},
              mapToolResultToToolResultBlockParam:(data:{value:string},id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
            })
            Object.assign(f.context,{mods:runtime,agentId:'child-fixture',setAppState:() => {},setInProgressToolUseIDs:() => {}})
            f.context.options.mcpClients=[]
            const block = {type:'tool_use' as const,caller:{type:'direct' as const},id:`policy-${streaming}`,name:f.tool.name,input:{value:'original'}}
            const assistant = createAssistantMessage({content:[block]})
            const allow = async (_tool: Tool,input:Record<string,unknown>) => {permissions.push(String(input.value));return {behavior:'allow' as const}}
            const executor = streaming ? new StreamingToolExecutor([f.tool],allow,f.context) : undefined
            executor?.addTool(block,assistant)
            const updates = await Array.fromAsync(executor ? executor.getRemainingResults() : runTools([block],[assistant],allow,f.context))
            expect(calls).toEqual(['original','original','second'])
            expect(permissions).toEqual(['original','original','second'])
            const observed=readFileSync(marker,'utf8').trim().split('\n').map(line => JSON.parse(line))
            expect(observed.map(item => [item.hook_event_name,item.tool_input.value])).toEqual([
              ['PreToolUse','original'],['PreToolUse','second'],['PostToolUse','original'],
            ])
            expect(observed.at(-1).tool_response).toEqual({value:'original'})
            const result = updates.find(update => update.message?.type === 'user')!.message!
            expect(result.type === 'user' && result.sourceToolAssistantUUID).toBe(assistant.uuid)
            expect(result.type === 'user' && result.toolUseResult).toBeUndefined()
            expect(JSON.stringify(updates)).not.toContain('user classic must be skipped')
            expect(modifiers).toBe(1)
          }
        } finally {await runtime.dispose()}
      },
    )
  }

  test('managed pre deny cannot be bypassed by a real Worker tool.call short circuit', async () => {
    const marker = join(home, 'managed-pre')
    configure({ hooks: { PreToolUse: [{ hooks: [{
      type: 'command',
      command: `printf x >> '${marker}'; printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'managed refusal' } })}'`,
    }] }] } })
    const entry = join(home, 'register.ts')
    writeFileSync(entry, `export function register(on) {
      on('tool.call', () => ({result:{value:'synthetic bypass'}}));
      on('classic.PreToolUse', () => ({allow:true}));
    }`)
    const runtime = createModsRuntime()
    try {
      await runtime.reconcile(seatNativeModPlugins([{
        name: 'boundary-fixture', storageId: 'boundary-fixture@inline',
        pluginRoot: home, entrypoints: [entry],
      }], {
        userSettings: null, flagSettings: null, policySettings: { enabledPlugins: {} },
        hookPolicy: { managedOnly: false, allDisabled: false },
      }))
      const f = fixture()
      let calls = 0
      let permissions = 0
      Object.assign(f.tool, {
        outputSchema: z.object({value:z.string()}),
        maxResultSizeChars: Infinity,
        call: async (input: unknown) => { calls++; return {data:input} },
        mapToolResultToToolResultBlockParam: (data: {value:string}, id: string) => ({type:'tool_result', tool_use_id:id, content:data.value}),
      })
      Object.assign(f.context, {mods:runtime, setAppState: () => {}, setInProgressToolUseIDs: () => {}})
      f.context.options.mcpClients = []
      const block = {type:'tool_use' as const, caller:{type:'direct' as const}, id:'managed-id', name:f.tool.name, input:{value:'original'}}
      const assistant = createAssistantMessage({content:[block]})
      const updates = await Array.fromAsync(runToolUse(block, assistant, async () => { permissions++; return {behavior:'allow'} }, f.context))
      expect(JSON.stringify(updates)).toContain('managed refusal')
      expect(JSON.stringify(updates)).not.toContain('synthetic bypass')
      expect(readFileSync(marker, 'utf8')).toBe('x')
      expect(calls).toBe(0)
      expect(permissions).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('without Mods the existing callback still executes exactly once', async () => {
    let executed = 0
    registerHookCallbacks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                executed++
                return {}
              },
            },
          ],
        },
      ],
    })
    const f = fixture()
    await Array.fromAsync(pre(f))
    expect(executed).toBe(1)
    expect(f.captures()).toBe(0)
  })
})
