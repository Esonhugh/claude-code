import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  clearRegisteredHooks,
  getIsInteractive,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { executePermissionRequestHooks } from '../../utils/hooks.js'
import { resetHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { runPreToolUseHooks } from './toolHooks.js'

let interactive: boolean
beforeEach(() => {
  interactive = getIsInteractive()
  setIsInteractive(false)
  clearRegisteredHooks()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const source of [
    'policySettings',
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
  ] as const)
    setCachedSettingsForSource(source, {})
})
afterEach(() => {
  clearRegisteredHooks()
  resetHooksConfigSnapshot()
  resetSettingsCache()
  setIsInteractive(interactive)
})

function fixture() {
  const tool = {
    name: 'Fixture',
    inputSchema: z.strictObject({ value: z.string() }),
    validateInput: async (input: { value: string }) =>
      input.value === 'refused'
        ? { result: false, message: 'value refused', errorCode: 7 }
        : { result: true },
    isReadOnly: () => false,
  } as unknown as Tool
  const context = {
    options: { tools: [tool], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionHooks: new Map(),
    }),
  } as unknown as ToolUseContext
  return { tool, context }
}

function hook(
  event: 'PreToolUse' | 'PermissionRequest',
  output: Record<string, unknown>,
) {
  registerHookCallbacks({
    [event]: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async () => ({
              hookSpecificOutput: { hookEventName: event, ...output },
            }),
          },
        ],
      },
    ],
  })
}

async function pre() {
  const { tool, context } = fixture()
  const results = await Array.fromAsync(
    runPreToolUseHooks(
      context,
      tool,
      { value: 'original' },
      'tool-id',
      'message-id',
      undefined,
      undefined,
      undefined,
    ),
  )
  const decisions = results.flatMap(r =>
    r.type === 'hookPermissionResult' ? [r.hookPermissionResult] : [],
  )
  return {
    // toolExecution keeps the last hookPermissionResult it sees.
    decision: decisions.at(-1) as
      | { behavior: string; message?: string }
      | undefined,
    rewrites: results.flatMap(r =>
      r.type === 'hookUpdatedInput' ? [r.updatedInput] : [],
    ),
  }
}

describe('PreToolUse updatedInput is validated against the tool schema', () => {
  test('wrong types deny the call', async () => {
    hook('PreToolUse', {
      permissionDecision: 'allow',
      updatedInput: { value: 42 },
    })
    const { decision, rewrites } = await pre()
    expect(decision?.behavior).toBe('deny')
    expect(decision?.message).toContain(
      'PreToolUse hook (sdk) for Fixture returned updatedInput that failed schema validation',
    )
    expect(rewrites).toEqual([])
  })

  test('a later allow does not lift the rewrite deny', async () => {
    hook('PreToolUse', {
      permissionDecision: 'allow',
      updatedInput: { value: 42 },
    })
    hook('PreToolUse', { permissionDecision: 'allow' })
    expect((await pre()).decision?.behavior).toBe('deny')
  })

  test('unknown keys are dropped', async () => {
    hook('PreToolUse', {
      permissionDecision: 'allow',
      updatedInput: { value: 'rewritten', extra: true },
    })
    const { decision, rewrites } = await pre()
    expect(decision?.behavior).toBe('allow')
    expect(rewrites).toEqual([{ value: 'rewritten' }])
  })

  test('passthrough rewrites are validated too', async () => {
    hook('PreToolUse', { updatedInput: { value: 'rewritten', extra: 1 } })
    expect(await pre()).toEqual({
      decision: undefined,
      rewrites: [{ value: 'rewritten' }],
    })
  })

  test('input the tool refuses denies the call', async () => {
    hook('PreToolUse', {
      permissionDecision: 'ask',
      updatedInput: { value: 'refused' },
    })
    const { decision } = await pre()
    expect(decision?.behavior).toBe('deny')
    expect(decision?.message).toContain(
      'returned updatedInput that the tool refused: value refused',
    )
  })
})

describe('PermissionRequest updatedInput is validated against the tool schema', () => {
  async function permissionRequest() {
    const { context } = fixture()
    const results = await Array.fromAsync(
      executePermissionRequestHooks(
        'Fixture',
        'tool-id',
        { value: 'original' },
        context,
      ),
    )
    return results.flatMap(r =>
      r.permissionRequestResult ? [r.permissionRequestResult] : [],
    )
  }

  test('wrong types turn the allow into a deny', async () => {
    hook('PermissionRequest', {
      decision: { behavior: 'allow', updatedInput: { value: ['x'] } },
    })
    const [decision] = await permissionRequest()
    expect(decision).toMatchObject({ behavior: 'deny' })
    expect((decision as { message: string }).message).toContain(
      'PermissionRequest hook (sdk) for Fixture returned updatedInput that failed schema validation',
    )
  })

  test('unknown keys are dropped from an allow', async () => {
    hook('PermissionRequest', {
      decision: {
        behavior: 'allow',
        updatedInput: { value: 'rewritten', extra: 1 },
      },
    })
    expect(await permissionRequest()).toEqual([
      { behavior: 'allow', updatedInput: { value: 'rewritten' } },
    ])
  })
})
