import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import type { ToolUseContext } from '../../Tool.js'
import type { AggregatedHookResult } from '../../utils/hooks.js'
import type { createModClassicAdapter } from './classicAdapter.js'

const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']
let savedEnv: (string | undefined)[]
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mod-classic-adapter-'))
  savedEnv = envKeys.map(key => process.env[key])
  for (const key of envKeys) process.env[key] = home
})
afterEach(() => {
  envKeys.forEach((key, i) => {
    if (savedEnv[i] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[i]
  })
  rmSync(home, { recursive: true, force: true })
})

// Execute the entire production adapter, replacing ONLY its existing classic
// executor module at the import boundary. No CLI bootstrap, real settings,
// hooks, processes, permission dialogs or model requests are imported/executed.
// This tests orchestration, NOT the executor's parsing/matching/source selection.
function fixture(
  results: AggregatedHookResult[] = [],
  hooks: {
    onResult?: (result: AggregatedHookResult) => void | Promise<void>
    execute?: () => AsyncIterable<AggregatedHookResult>
    sourceScope?: 'managed' | 'non-managed'
  } = {},
) {
  const calls: { name: string; args: unknown[] }[] = []
  const observed: { event: string; result: AggregatedHookResult }[] = []
  const executors = Object.fromEntries(
    [
      'executePreToolHooks',
      'executePostToolHooks',
      'executePostToolUseFailureHooks',
      'executePermissionDeniedHooks',
      'executePermissionRequestHooks',
      'executeUserPromptSubmitHooks',
      'executeStopHooks',
      'executeSessionStartHooks',
      'executeSetupHooks',
      'executeSubagentStartHooks',
    ].map(name => [
      name,
      async function* (...args: unknown[]) {
        calls.push({ name, args })
        yield* hooks.execute?.() ?? results
      },
    ]),
  )
  const source = readFileSync(
    new URL('./classicAdapter.ts', import.meta.url),
    'utf8',
  )
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText
  const exports: {
    createModClassicAdapter?: typeof createModClassicAdapter
  } = {}
  new Function('require', 'exports', code)((name: string) => {
    if (name === '../../utils/hooks.js') return executors
    throw new Error(`Unexpected production dependency: ${name}`)
  }, exports)
  let context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    options: { tools: [] },
    messages: [],
  } as unknown as ToolUseContext
  let sessionId = 'session-one'
  const adapter = exports.createModClassicAdapter!({
    sourceScope: hooks.sourceScope,
    getToolUseContext: () => context,
    getSessionId: () => sessionId,
    getMessages: () => context.messages,
    getToolUseID: () => 'host-tool-use',
    onHookResult: async (event, result) => {
      observed.push({ event, result })
      await hooks.onResult?.(result)
    },
  })
  return {
    ...adapter,
    calls,
    observed,
    results,
    get context() {
      return context
    },
    set context(value) {
      context = value
    },
    get sessionId() {
      return sessionId
    },
    set sessionId(value: string) {
      sessionId = value
    },
  }
}

const base = {
  session_id: 'session-one',
  transcript_path: '/fixture/transcript',
  cwd: '/fixture',
}

describe('classic adapter executor boundary', () => {
  test.each(['ask', 'deny'] as const)('uses the latest correctly attributed %s reason from the executor', async permissionBehavior => {
    const f = fixture([
      { permissionBehavior, hookPermissionDecisionReason: 'first', hookSource: 'userSettings' },
      { permissionBehavior, hookPermissionDecisionReason: 'last', hookSource: 'sdk' },
    ])
    expect(await f.classic.PreToolUse({ tool: 'Read', tool_use_id: 'reason' })).toEqual({ [permissionBehavior]: 'last' })
  })

  test('raw goal/source/progress metadata stays observable without leaking into the fold', async () => {
    const hook = { type: 'prompt' as const, prompt: 'goal fixture' }
    const raw = {
      hook,
      hookSource: 'policySettings',
      impossible: true,
      stopReason: 'goal cannot finish',
      blockingError: { blockingError: 'goal veto', command: 'goal fixture' },
      additionalContexts: ['same', 'same'],
      message: { type: 'progress', data: { type: 'hook_progress' } },
    } as unknown as AggregatedHookResult
    const f = fixture([raw], { sourceScope: 'managed' })
    const folded = await f.classic.Stop({
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    })
    expect(f.observed[0]?.result).toBe(raw)
    expect(f.observed[0]?.result.hook).toBe(hook)
    expect(folded).toEqual({
      block: 'goal veto',
      stopReason: 'goal cannot finish',
      additionalContext: ['same', 'same'],
    })
  })
  test.each(['managed', 'non-managed'] as const)(
    'passes %s scope to every existing executor once',
    async sourceScope => {
      const f = fixture([], { sourceScope })
      const tool = {
        ...base,
        tool_name: 'Read',
        tool_use_id: 'id',
        tool_input: {},
      }
      await f.classic.PreToolUse({ tool: 'Read', tool_use_id: 'id' })
      await f.classic.PostToolUse({
        ...tool,
        hook_event_name: 'PostToolUse',
        tool_response: null,
      })
      await f.classic.PostToolUseFailure({
        ...tool,
        hook_event_name: 'PostToolUseFailure',
        error: 'failed',
      })
      await f.classic.PermissionDenied({
        ...tool,
        hook_event_name: 'PermissionDenied',
        reason: 'deny',
      })
      await f.classic.PermissionRequest({
        ...tool,
        hook_event_name: 'PermissionRequest',
      })
      await f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'text',
      })
      await f.classic.Stop({
        ...base,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      })
      await f.classic.SubagentStop({
        ...base,
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: 'child',
        agent_type: 'test',
        agent_transcript_path: '/fixture/child',
      })
      await f.classic.SessionStart({
        ...base,
        hook_event_name: 'SessionStart',
        source: 'startup',
      })
      await f.classic.Setup({
        ...base,
        hook_event_name: 'Setup',
        trigger: 'init',
      })
      await f.classic.SubagentStart({
        ...base,
        hook_event_name: 'SubagentStart',
        agent_id: 'child',
        agent_type: 'test',
      })
      expect(f.calls.map(call => call.args.at(-1))).toEqual(
        Array(11).fill(sourceScope),
      )
      expect(f.calls.map(call => call.name)).toEqual([
        'executePreToolHooks',
        'executePostToolHooks',
        'executePostToolUseFailureHooks',
        'executePermissionDeniedHooks',
        'executePermissionRequestHooks',
        'executeUserPromptSubmitHooks',
        'executeStopHooks',
        'executeStopHooks',
        'executeSessionStartHooks',
        'executeSetupHooks',
        'executeSubagentStartHooks',
      ])
    },
  )
  test('an in-flight call retains its context while later calls read the current getter', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const f = fixture([], {
      execute: async function* () {
        entered()
        await gate
        yield { additionalContexts: ['complete'] }
      },
    })
    const first = f.context
    const pending = f.classic.PreToolUse({
      tool: 'Read',
      tool_use_id: 'first',
    })
    await started
    const second = { ...first, abortController: new AbortController() }
    f.context = second
    second.abortController.abort(
      new Error('only the next invocation is aborted'),
    )
    release()
    expect(await pending).toEqual({ additionalContext: ['complete'] })
    expect(f.calls[0]!.args[3]).toBe(first)
    await expect(
      f.classic.PreToolUse({ tool: 'Read', tool_use_id: 'second' }),
    ).rejects.toThrow('only the next')
    expect(f.calls).toHaveLength(1)
  })

  test('repeated explicit noun calls execute once each rather than cache results or tool IDs', async () => {
    const f = fixture([
      {
        permissionBehavior: 'ask',
        hookPermissionDecisionReason: 'first ask',
      },
    ])
    const input = { tool: 'Read', tool_use_id: 'same-explicit-call' }
    expect(await f.classic.PreToolUse(input)).toEqual({ ask: 'first ask' })
    f.results.splice(0, 1, {
      permissionBehavior: 'deny',
      hookPermissionDecisionReason: 'now denied',
    })
    expect(await f.classic.PreToolUse(input)).toEqual({ deny: 'now denied' })
    expect(f.calls).toHaveLength(2)
  })
  test('a repeated aggregate deny cannot replace the blocking reason with a later allow hook reason', async () => {
    const f = fixture([
      {
        blockingError: {
          blockingError: 'policy block',
          command: 'deny hook',
        },
      },
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'policy block',
      },
      // A block still wins even if another producer supplies a later reason.
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'safe to allow',
      },
    ])
    expect(
      await f.classic.PreToolUse({ tool: 'Read', tool_use_id: 'aggregate' }),
    ).toEqual({ deny: 'policy block' })
  })
  test('a per-hook cancellation diagnostic is delivered without inventing a whole-turn abort', async () => {
    const diagnostic = {
      message: { type: 'attachment', attachment: { type: 'hook_cancelled' } },
    } as unknown as AggregatedHookResult
    const f = fixture([
      diagnostic,
      { additionalContexts: ['another hook finished'] },
    ])
    expect(
      await f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'text',
      }),
    ).toEqual({ additionalContext: ['another hook finished'] })
    expect(f.observed[0]!.result).toBe(diagnostic)
  })

  test('requestPrompt receives the existing tool summary for pre-tool and permission-request hooks', async () => {
    const f = fixture()
    const requestPrompt = (() => {
      throw new Error('the adapter must not prompt itself')
    }) as ToolUseContext['requestPrompt']
    const tool = {
      name: 'Read',
      getToolUseSummary: (args: Record<string, unknown>) =>
        `read ${args.file_path}`,
    }
    f.context = {
      ...f.context,
      requestPrompt,
      options: { ...f.context.options, tools: [tool as never] },
    }
    await f.classic.PreToolUse({
      tool: 'Read',
      tool_use_id: 'summary',
      file_path: '/fixture/file',
    })
    expect(f.calls[0]!.args[7]).toBe(requestPrompt)
    expect(f.calls[0]!.args[8]).toBe('read /fixture/file')
    await f.classic.PermissionRequest({
      ...base,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: '/fixture/other' },
    })
    expect(f.calls[1]!.args[8]).toBe(requestPrompt)
    expect(f.calls[1]!.args[9]).toBe('read /fixture/other')
  })
  test('invalid event names and malformed payloads reject before classic side effects', async () => {
    const f = fixture()
    await expect(
      f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'Stop',
        prompt: 'wrong event',
      } as never),
    ).rejects.toThrow('UserPromptSubmit')
    await expect(
      f.classic.PreToolUse({ tool: 'Read', tool_use_id: 42 } as never),
    ).rejects.toThrow('tool_use_id')
    await expect(
      f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: {},
      } as never),
    ).rejects.toThrow('prompt')
    await expect(
      f.classic.SessionStart({
        ...base,
        hook_event_name: 'SessionStart',
        source: 'fork',
      } as never),
    ).rejects.toThrow('valid source')
    expect(f.calls).toHaveLength(0)
  })
  test.each(['PreToolUse', 'UserPromptSubmit', 'Stop'] as const)(
    '%s rejects pre-abort without entering the executor',
    async event => {
      const f = fixture()
      const reason = new Error('cancelled before entry')
      f.context.abortController.abort(reason)
      const input =
        event === 'PreToolUse'
          ? { tool: 'Read', tool_use_id: 'pre-abort' }
          : {
              ...base,
              hook_event_name: event,
              prompt: 'text',
              stop_hook_active: false,
            }
      await expect(f.classic[event](input as never)).rejects.toBe(reason)
      expect(f.calls).toHaveLength(0)
    },
  )

  test('cancellation during delivery rejects, closes the generator and does not take another yield', async () => {
    let closed = false
    let advanced = false
    const reason = new Error('cancelled in flight')
    const f = fixture([], {
      execute: async function* () {
        try {
          yield { additionalContexts: ['first'] }
          advanced = true
          yield { permissionBehavior: 'allow' }
        } finally {
          closed = true
        }
      },
      onResult: () => {
        f.context.abortController.abort(reason)
      },
    })
    await expect(
      f.classic.PreToolUse({ tool: 'Read', tool_use_id: 'in-flight' }),
    ).rejects.toBe(reason)
    expect(closed).toBe(true)
    expect(advanced).toBe(false)
  })

  test('cancellation with no yielded result is not mistaken for an empty success', async () => {
    const reason = new Error('cancelled without a yield')
    const f = fixture([], {
      execute: async function* () {
        f.context.abortController.abort(reason)
        yield* []
      },
    })
    await expect(
      f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'text',
      }),
    ).rejects.toBe(reason)
  })

  test('executor and observer errors propagate without fabricated success', async () => {
    const failure = new Error('executor failure')
    const f = fixture([], {
      execute: async function* () {
        yield* []
        throw failure
      },
    })
    await expect(
      f.classic.Stop({
        ...base,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
    ).rejects.toBe(failure)
    const observerFailure = new Error('observer failure')
    const other = fixture([{}], {
      onResult: () => {
        throw observerFailure
      },
    })
    await expect(
      other.classic.PreToolUse({ tool: 'Read', tool_use_id: 'observer' }),
    ).rejects.toBe(observerFailure)
  })

  test('empty classic hooks produce empty answers, not an implicit permission allow', async () => {
    const f = fixture()
    expect(
      await f.classic.PreToolUse({ tool: 'Read', tool_use_id: 'empty' }),
    ).toEqual({})
    expect(
      await f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: '',
      }),
    ).toEqual({})
  })
  test('PreToolUse continue:false cannot become allow and reports the stop through the host observer', async () => {
    const f = fixture([
      { preventContinuation: true, stopReason: 'session stopped' },
      { permissionBehavior: 'allow', updatedInput: { command: 'changed' } },
    ])
    expect(
      await f.classic.PreToolUse({ tool: 'Bash', tool_use_id: 'stopped' }),
    ).toEqual({
      deny: 'session stopped',
      updatedInput: { command: 'changed' },
    })
    expect(f.observed[0]!.result.preventContinuation).toBe(true)
    expect(f.context.abortController.signal.aborted).toBe(false)
  })
  test('SessionStart, Setup and SubagentStart preserve lifecycle data and fresh session identity', async () => {
    const f = fixture([
      {
        initialUserMessage: 'first',
        watchPaths: ['/first'],
        additionalContexts: ['one'],
      },
      {
        initialUserMessage: 'last',
        watchPaths: ['/last'],
        additionalContexts: ['two'],
      },
    ])
    f.sessionId = 'session-two'
    f.context = {
      ...f.context,
      agentType: 'custom',
      options: { ...f.context.options, mainLoopModel: 'model-two' },
    }
    expect(
      await f.classic.SessionStart({
        ...base,
        session_id: 'session-two',
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
    ).toEqual({
      initialUserMessage: 'last',
      watchPaths: ['/last'],
      additionalContext: ['one', 'two'],
    })
    expect(f.calls[0]!.args.slice(0, 4)).toEqual([
      'resume',
      'session-two',
      'custom',
      'model-two',
    ])
    expect(
      await f.classic.Setup({
        ...base,
        hook_event_name: 'Setup',
        trigger: 'init',
      }),
    ).toEqual({ additionalContext: ['one', 'two'] })
    expect(f.calls[1]!.args[0]).toBe('init')
    expect(
      await f.classic.SubagentStart({
        ...base,
        hook_event_name: 'SubagentStart',
        agent_id: 'child',
        agent_type: 'Explore',
      }),
    ).toEqual({ additionalContext: ['one', 'two'] })
    expect(f.calls[2]!.args.slice(0, 2)).toEqual(['child', 'Explore'])
  })
  test('tool failure and permission denial route distinct inputs and event-specific results', async () => {
    const f = fixture([{ additionalContexts: ['error context'], retry: true }])
    expect(
      await f.classic.PostToolUseFailure({
        ...base,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: 'failed',
        tool_input: {},
        error: 'interrupted',
        is_interrupt: true,
      }),
    ).toEqual({ additionalContext: ['error context'] })
    expect(f.calls[0]!.name).toBe('executePostToolUseFailureHooks')
    expect(f.calls[0]!.args.slice(0, 6)).toEqual([
      'Bash',
      'failed',
      {},
      'interrupted',
      f.context,
      true,
    ])
    expect(
      await f.classic.PermissionDenied({
        ...base,
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_use_id: 'denied',
        tool_input: {},
        reason: 'rule',
      }),
    ).toEqual({ retry: true })
    expect(f.calls[1]!.name).toBe('executePermissionDeniedHooks')
    expect(f.calls[1]!.args.slice(0, 5)).toEqual([
      'Bash',
      'denied',
      {},
      'rule',
      f.context,
    ])
  })
  test('PermissionRequest preserves the last decision and suggestions but never persists rules or aborts the host', async () => {
    const rules = [
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ] as const
    const f = fixture([
      {
        permissionRequestResult: {
          behavior: 'allow',
          updatedInput: { x: 1 },
          updatedPermissions: [...rules],
        },
      },
      {
        permissionRequestResult: {
          behavior: 'deny',
          message: 'refused',
          interrupt: true,
        },
        additionalContexts: ['not a permission field'],
      },
    ])
    expect(
      await f.classic.PermissionRequest({
        ...base,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: { x: 0 },
        permission_suggestions: [...rules],
      }),
    ).toEqual({
      decision: { behavior: 'deny', message: 'refused', interrupt: true },
    })
    expect(f.context.abortController.signal.aborted).toBe(false)
    expect(f.calls[0]!.args.slice(0, 3)).toEqual([
      'Read',
      'host-tool-use',
      { x: 0 },
    ])
    expect(f.calls[0]!.args[5]).toEqual(rules)
    f.results.splice(1)
    expect(
      await f.classic.PermissionRequest({
        ...base,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: {},
      }),
    ).toEqual({
      decision: {
        behavior: 'allow',
        updatedInput: { x: 1 },
        updatedPermissions: [...rules],
      },
    })
    f.results.splice(0, 1, {
      permissionRequestResult: { behavior: 'deny', interrupt: false },
    })
    expect(
      await f.classic.PermissionRequest({
        ...base,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: {},
      }),
    ).toEqual({ decision: { behavior: 'deny' } })
  })
  test('Stop and SubagentStop use fresh conversation context and preserve re-prompt/stop results', async () => {
    const f = fixture([
      {
        blockingError: { blockingError: 'continue work', command: 'stop' },
        additionalContexts: ['note'],
      },
    ])
    f.context = {
      ...f.context,
      messages: [{ type: 'user', message: { content: 'new turn' } } as never],
    }
    expect(
      await f.classic.Stop({
        ...base,
        hook_event_name: 'Stop',
        stop_hook_active: true,
      }),
    ).toEqual({ block: 'continue work', additionalContext: ['note'] })
    expect(f.calls[0]!.args[3]).toBe(true)
    expect(f.calls[0]!.args[4]).toBeUndefined()
    expect(f.calls[0]!.args[5]).toBe(f.context)
    expect(f.calls[0]!.args[6]).toBe(f.context.messages)
    await f.classic.SubagentStop({
      ...base,
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'child',
      agent_type: 'Explore',
      agent_transcript_path: '/fixture/child',
    })
    expect(f.calls[1]!.args[4]).toBe('child')
    expect(f.calls[1]!.args[7]).toBe('Explore')
  })
  test('PostToolUse folds replacement/context without serializing progress and filters event-specific fields', async () => {
    const f = fixture([
      {
        updatedMCPToolOutput: { value: 'first' },
        additionalContexts: ['one'],
      },
      {
        updatedMCPToolOutput: null,
        additionalContexts: ['two'],
        retry: true,
        initialUserMessage: 'wrong event',
      },
    ])
    expect(
      await f.classic.PostToolUse({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__test__call',
        tool_use_id: 'post',
        tool_input: { n: 1 },
        tool_response: { old: true },
      }),
    ).toEqual({
      updatedMCPToolOutput: null,
      additionalContext: ['one', 'two'],
    })
    expect(f.calls[0]!.name).toBe('executePostToolHooks')
    expect(f.calls[0]!.args.slice(0, 4)).toEqual([
      'mcp__test__call',
      'post',
      { n: 1 },
      { old: true },
    ])
  })
  test('UserPromptSubmit returns block/stop/context, last write wins and does not leak executor-only fields', async () => {
    const f = fixture([
      {
        blockingError: { blockingError: 'first', command: 'a' },
        additionalContexts: ['one'],
      },
      { preventContinuation: true, stopReason: 'stop' },
      {
        blockingError: { blockingError: 'last', command: 'b' },
        additionalContexts: ['two', 'two'],
        updatedInput: { ignored: true },
      },
    ])
    expect(
      await f.classic.UserPromptSubmit({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'text',
      }),
    ).toEqual({
      block: 'last',
      preventContinuation: true,
      stopReason: 'stop',
      additionalContext: ['one', 'two', 'two'],
    })
    expect(f.calls[0]!.args.slice(0, 3)).toEqual(['text', 'default', f.context])
    expect(f.observed).toHaveLength(3)
  })
  test('PreToolUse retains ask precedence, last input rewrite and live context without running a tool', async () => {
    const f = fixture([
      { permissionBehavior: 'allow', updatedInput: { command: 'first' } },
      { permissionBehavior: 'ask', hookPermissionDecisionReason: 'confirm' },
      // The executor repeats the accumulated decision with each hook result.
      { permissionBehavior: 'ask', hookPermissionDecisionReason: undefined },
      { updatedInput: { command: 'last' } },
    ])
    const current = { ...f.context, abortController: new AbortController() }
    f.context = current
    expect(
      await f.classic.PreToolUse({
        tool: 'Bash',
        tool_use_id: 'rewrite',
        command: 'original',
      }),
    ).toEqual({ ask: 'confirm', updatedInput: { command: 'last' } })
    expect(f.calls[0]!.args[3]).toBe(current)
    expect(f.calls[0]!.args[5]).toBe(current.abortController.signal)
    f.results.splice(0, f.results.length, { permissionBehavior: 'allow' })
    expect(
      await f.classic.PreToolUse({ tool: 'Bash', tool_use_id: 'allow' }),
    ).toEqual({ allow: true })
  })
  test('PreToolUse folds the existing executor deny and ordered contexts into the official shape', async () => {
    const f = fixture([
      { additionalContexts: ['first', 'same'] },
      {
        blockingError: {
          blockingError: 'managed refusal',
          command: 'fixture',
        },
      },
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'managed refusal',
      },
      { additionalContexts: ['same', 'last'] },
    ])
    expect(
      await f.classic.PreToolUse({
        tool: 'Bash',
        tool_use_id: 'call-1',
        command: 'echo test',
      }),
    ).toEqual({
      deny: 'managed refusal',
      additionalContext: ['first', 'same', 'same', 'last'],
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.name).toBe('executePreToolHooks')
    expect(f.calls[0]!.args.slice(0, 3)).toEqual([
      'Bash',
      'call-1',
      { command: 'echo test' },
    ])
    expect(f.observed.map(item => item.result)).toEqual(f.results)
  })
})
