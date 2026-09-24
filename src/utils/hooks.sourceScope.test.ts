import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createModsSession } from '../services/mods/session.js'
import { disposeModsHosts, endModsSessions } from './gracefulShutdown.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../Tool.js'
import type { HookCallback } from '../types/hooks.js'
import type {
  HookEvent,
  SyncHookJSONOutput,
} from '../entrypoints/agentSdkTypes.js'
import type { AppState } from '../state/AppState.js'
import type { SettingsJson, HookCommand } from './settings/types.js'
import type { SettingSource } from './settings/constants.js'
import type { AggregatedHookResult, HookSourceScope } from './hooks.js'

const envKeys = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_SHELL_PREFIX',
]
let savedEnv: (string | undefined)[]
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hooks-executor-'))
  savedEnv = envKeys.map((key) => process.env[key])
  for (const key of envKeys.slice(0, 4)) process.env[key] = home
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_SHELL_PREFIX
})
afterEach(() => {
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  })
  rmSync(home, { recursive: true, force: true })
})

const compiled = new Map<string, string>()
function evaluate(path: string, require: (name: string) => unknown) {
  let code = compiled.get(path)
  if (!code) {
    code = ts.transpileModule(
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText
    compiled.set(path, code)
  }
  const exports = {}
  new Function('require', 'exports', code)(require, exports)
  return exports
}

// Run the complete production executor, snapshot, session store, parser schemas,
// dedup and concurrent generator. Replace I/O at imports, never executor bodies.
// Commands use local fake child streams; callbacks execute normally. No global
// mock.module, CLI bootstrap, real settings/credentials, shell or network access.
function fixture() {
  const settings: Partial<Record<SettingSource, SettingsJson>> = {}
  const registered: Partial<
    Record<
      HookEvent,
      Array<{
        matcher: string
        hooks: Array<HookCallback | HookCommand>
        pluginRoot?: string
        pluginName?: string
      }>
    >
  > = {}
  const commands = new Map<
    string,
    SyncHookJSONOutput | (() => Promise<SyncHookJSONOutput>)
  >()
  const calls: { command: string; input: Record<string, unknown> }[] = []
  const state = { sessionHooks: new Map() } as unknown as AppState
  const context = {
    getAppState: () => state,
    options: { tools: [] },
    abortController: new AbortController(),
    setResponseLength: () => {},
  } as unknown as ToolUseContext
  const controls = {
    trusted: true,
    interactive: true,
    allowed: [
      'userSettings',
      'projectSettings',
      'localSettings',
    ] as SettingSource[],
    resets: 0,
  }
  const noop = () => {}
  const bootstrap = {
    getSessionId: () => 'executor-session',
    getProjectRoot: () => home,
    getOriginalCwd: () => home,
    getMainThreadAgentType: () => undefined,
    getIsNonInteractiveSession: () => !controls.interactive,
    getRegisteredHooks: () => registered,
    getStatsStore: () => undefined,
    addToTurnHookDuration: noop,
    resetSdkInitState: noop,
    getAllowedSettingSources: () => controls.allowed,
  }
  const settingsModule = {
    getSettingsForSource: (source: SettingSource) => settings[source] ?? null,
    getSettings_DEPRECATED: () => {
      const merged: SettingsJson = {}
      for (const source of constants.getEnabledSettingSources()) {
        const entry = settings[source]
        if (!entry) continue
        Object.assign(merged, entry, { hooks: { ...merged.hooks } })
        for (const [event, matchers] of Object.entries(entry.hooks ?? {})) {
          const name = event as HookEvent
          merged.hooks![name] = [...(merged.hooks![name] ?? []), ...matchers!]
        }
      }
      return merged
    },
  }
  const constants = evaluate(
    './settings/constants.ts',
    () => bootstrap,
  ) as typeof import('./settings/constants.js')
  const lazy = evaluate('./lazySchema.ts', () => {
    throw new Error('Unexpected lazySchema import')
  })
  const rule = evaluate('./permissions/PermissionRule.ts', (name) =>
    name === 'zod/v4' ? { default: z } : lazy,
  )
  const updates = evaluate(
    './permissions/PermissionUpdateSchema.ts',
    (name) => {
      if (name === 'zod/v4') return { default: z }
      if (name.endsWith('lazySchema.js')) return lazy
      if (name.endsWith('PermissionRule.js')) return rule
      if (name.endsWith('PermissionMode.js'))
        return {
          externalPermissionModeSchema: () =>
            z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']),
        }
      throw new Error(`Unexpected schema dependency: ${name}`)
    },
  )
  const schemas = evaluate('../types/hooks.ts', (name) => {
    if (name === 'zod/v4') return { z }
    if (name.endsWith('lazySchema.js')) return lazy
    if (name.endsWith('PermissionRule.js')) return rule
    if (name.endsWith('PermissionUpdateSchema.js')) return updates
    if (name.endsWith('agentSdkTypes.js')) return { HOOK_EVENTS: [] }
    throw new Error(`Unexpected hooks schema dependency: ${name}`)
  })
  const pluginPolicy = evaluate(
    './settings/pluginOnlyPolicy.ts',
    () => settingsModule,
  )
  const snapshot = evaluate('./hooks/hooksConfigSnapshot.ts', (name) => {
    if (name.endsWith('state.js')) return bootstrap
    if (name.endsWith('pluginOnlyPolicy.js')) return pluginPolicy
    if (name.endsWith('settings.js')) return settingsModule
    if (name.endsWith('constants.js')) return constants
    if (name.endsWith('settingsCache.js'))
      return {
        resetSettingsCache: () => {
          controls.resets++
        },
      }
    throw new Error(`Unexpected snapshot dependency: ${name}`)
  }) as typeof import('./hooks/hooksConfigSnapshot.js')
  const hookSettings = evaluate('./hooks/hooksSettings.ts', (name) => {
    if (name === 'path') return require('node:path')
    if (name.endsWith('state.js')) return bootstrap
    if (name.endsWith('constants.js')) return constants
    if (name.endsWith('settings.js')) return settingsModule
    if (name.endsWith('shellProvider.js')) return { DEFAULT_HOOK_SHELL: 'bash' }
    if (name.endsWith('sessionHooks.js'))
      return {
        getSessionHooks: (
          ...args: Parameters<typeof session.getSessionHooks>
        ) => session.getSessionHooks(...args),
      }
    throw new Error(`Unexpected hook settings dependency: ${name}`)
  })
  const session = evaluate('./hooks/sessionHooks.ts', (name) => {
    if (name.endsWith('agentSdkTypes.js')) return { HOOK_EVENTS: [] }
    if (name.endsWith('debug.js')) return { logForDebugging: noop }
    if (name.endsWith('hooksSettings.js')) return hookSettings
    throw new Error(`Unexpected session dependency: ${name}`)
  }) as typeof import('./hooks/sessionHooks.js')
  const generators = evaluate('./generators.ts', () => {
    throw new Error('Unexpected generators import')
  })
  const signals = evaluate('./combinedAbortSignal.ts', () => ({
    createAbortController: () => new AbortController(),
  }))
  let pid = 0
  const dependencies: Record<string, unknown> = {
    path: require('node:path'),
    crypto: require('node:crypto'),
    child_process: {
      spawn: (command: string) => {
        const child = Object.assign(new EventEmitter(), {
          pid: ++pid,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        })
        let input = ''
        child.stdin.on('data', (chunk) => {
          input += chunk
        })
        child.stdin.on('finish', () => {
          calls.push({ command, input: JSON.parse(input) })
          const response = commands.get(command)
          void Promise.resolve(
            typeof response === 'function' ? response() : (response ?? {}),
          ).then((json) => {
            child.stdout.end(JSON.stringify(json) + '\n')
            child.stderr.end()
            child.emit('close', 0)
          })
        })
        return child
      },
    },
    './gracefulShutdown.js': { endModsSessions },
    './file.js': { pathExists: async () => true },
    './ShellCommand.js': { wrapSpawn: () => ({ cleanup: noop }) },
    './task/TaskOutput.js': { TaskOutput: class {} },
    './cwd.js': { getCwd: () => home },
    './sessionEnvironment.js': {
      getHookEnvFilePath: async () => join(home, 'env'),
      invalidateSessionEnvCache: noop,
    },
    './subprocessEnv.js': { subprocessEnv: () => ({ HOME: home }) },
    './platform.js': { getPlatform: () => 'macos' },
    './shell/shellProvider.js': { DEFAULT_HOOK_SHELL: 'bash' },
    '../bootstrap/state.js': bootstrap,
    './config.js': { checkHasTrustDialogAccepted: () => controls.trusted },
    './hooks/hooksConfigSnapshot.js': snapshot,
    './sessionStorage.js': {
      getTranscriptPathForSession: () => join(home, 'transcript'),
      getAgentTranscriptPath: () => join(home, 'agent-transcript'),
    },
    './settings/settings.js': settingsModule,
    'src/services/analytics/index.js': { logEvent: noop },
    './telemetry/sessionTracing.js': {
      isBetaTracingEnabled: () => false,
      startHookSpan: noop,
      endHookSpan: noop,
    },
    '../types/hooks.js': schemas,
    './hooks/hooksSettings.js': hookSettings,
    './debug.js': { logForDebugging: noop },
    './diagLogs.js': { logForDiagnosticsNoPII: noop },
    './stringUtils.js': { firstLineOf: (text: string) => text.split('\n')[0] },
    './permissions/permissionRuleParser.js': {
      normalizeLegacyToolName: (name: string) => name,
      getLegacyToolNames: () => [],
    },
    './log.js': {
      logError: (error: Error) => {
        throw error
      },
    },
    './combinedAbortSignal.js': signals,
    './hooks/hookEvents.js': {
      emitHookStarted: noop,
      emitHookResponse: noop,
      startHookProgressInterval: () => noop,
    },
    './attachments.js': {
      createAttachmentMessage: (attachment: unknown) => ({
        type: 'attachment',
        attachment,
      }),
    },
    './generators.js': generators,
    './hooks/sessionHooks.js': session,
    './slowOperations.js': {
      jsonStringify: JSON.stringify,
      jsonParse: JSON.parse,
    },
    './envUtils.js': {
      isEnvTruthy: (value: string) => value === '1' || value === 'true',
      isSSHLocalUI: () => false,
    },
    './errors.js': { errorMessage: String, getErrnoCode: () => undefined },
    './messages.js': { getLastAssistantMessage: () => undefined },
  }
  const evaluatorResponse = {
    ok: false,
    reason: 'goal pending',
    impossible: false,
  }
  const helpers = evaluate('./hooks/hookHelpers.ts', (name) => {
    if (name === 'zod/v4') return { z }
    if (name.endsWith('lazySchema.js')) return lazy
    if (name.endsWith('argumentSubstitution.js'))
      return { substituteArguments: (prompt: string) => prompt }
    if (
      name.endsWith('SyntheticOutputTool.js') ||
      name.endsWith('messages.js') ||
      name.endsWith('sessionHooks.js')
    )
      return {}
    throw new Error(`Unexpected hook helper dependency: ${name}`)
  })
  dependencies['./hooks/execPromptHook.js'] = evaluate(
    './hooks/execPromptHook.ts',
    (name) => {
      if (name === 'crypto') return dependencies.crypto
      if (name.endsWith('api/claude.js'))
        return {
          queryModelWithoutStreaming: async () => ({
            message: { content: JSON.stringify(evaluatorResponse) },
          }),
        }
      if (name.endsWith('attachments.js'))
        return dependencies['./attachments.js']
      if (name.endsWith('combinedAbortSignal.js')) return signals
      if (name.endsWith('debug.js')) return dependencies['./debug.js']
      if (name.endsWith('errors.js')) return dependencies['./errors.js']
      if (name.endsWith('json.js')) return { safeParseJSON: JSON.parse }
      if (name.endsWith('messages.js'))
        return {
          createUserMessage: (message: unknown) => ({ type: 'user', message }),
          extractTextContent: (text: string) => text,
        }
      if (name.endsWith('model/model.js'))
        return { getSmallFastModel: () => 'local-fake-evaluator' }
      if (name.endsWith('systemPromptType.js'))
        return { asSystemPrompt: (value: unknown) => value }
      if (name.endsWith('hookHelpers.js')) return helpers
      return new Proxy(
        {},
        {
          get: (_target, key) => {
            throw new Error(
              `Unstubbed prompt dependency: ${name}.${String(key)}`,
            )
          },
        },
      )
    },
  )
  const hooks = evaluate(
    './hooks.ts',
    (name) =>
      dependencies[name] ??
      new Proxy(
        {},
        {
          get: (_target, key) => {
            throw new Error(
              `Unstubbed executor dependency: ${name}.${String(key)}`,
            )
          },
        },
      ),
  ) as typeof import('./hooks.js')
  const add = (source: SettingSource, event: HookEvent, command: string) => {
    settings[source] ??= {}
    settings[source]!.hooks ??= {}
    settings[source]!.hooks![event] ??= []
    settings[source]!.hooks![event]!.push({
      matcher: '',
      hooks: [{ type: 'command', command }],
    })
  }
  return {
    hooks,
    snapshot,
    settings,
    registered,
    commands,
    calls,
    controls,
    context,
    state,
    session,
    add,
    evaluatorResponse,
  }
}

test('SessionEnd executor finishes classic hooks before Worker session.end and uses a fresh signal', async () => {
  const f = fixture()
  const output = join(home, 'end-order')
  await writeFile(join(home, 'register.ts'), `export function register(on) {
    on('session.end', async ($, e, next) => {
      const before = await $.fs.read('./end-order');
      await $.clock.sleep(10);
      await $.fs.write('./end-order', before + '\\nmods:' + e.reason + ':' + e.sessionId);
      return next(e);
    });
  }`)
  const diagnostics: string[] = []
  const host = createModsSession({
    isTrusted: true,
    getSettings: () => ({userSettings:null, flagSettings:null, policySettings:null, hookPolicy:{managedOnly:false,allDisabled:false}}),
    loadPlugins: async () => [{name:'end-order',manifest:{name:'end-order'},source:'end-order@inline',repository:'end-order@inline',path:home,enabled:true,hookModules:[{configPath:join(home,'hooks.json'),paths:['./register.ts']}]}],
    onDiagnostic: event => diagnostics.push(event.message),
  })
  try {
    await host.bind({cwd:home,sessionId:'executor-session',isInteractive:false,surface:null})
    expect(diagnostics).toEqual([])
    const classicSignal = new AbortController()
    f.add('userSettings', 'SessionEnd', 'finish-classic')
    f.commands.set('finish-classic', async () => {
      await writeFile(output, 'classic')
      classicSignal.abort()
      return {}
    })
    await f.hooks.executeSessionEndHooks('clear', {signal:classicSignal.signal, timeoutMs:1500})
    expect(f.calls.map(call => call.input.reason)).toEqual(['clear'])
    expect(await readFile(output, 'utf8')).toBe('classic\nmods:clear:executor-session')
    expect(diagnostics).toEqual([])
    await disposeModsHosts()
    expect(host.runtime).toBeUndefined()
  } finally {
    await host.dispose()
  }
})

async function collect(iterator: AsyncIterable<AggregatedHookResult>) {
  const results: AggregatedHookResult[] = []
  for await (const result of iterator) results.push(result)
  return results
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function pre(f: ReturnType<typeof fixture>, scope?: HookSourceScope) {
  return f.hooks.executePreToolHooks(
    'Read',
    'tool',
    {},
    f.context,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    scope,
  )
}

const invocations: Array<
  [
    HookEvent,
    (
      f: ReturnType<typeof fixture>,
      scope?: HookSourceScope,
    ) => AsyncIterable<AggregatedHookResult>,
  ]
> = [
  ['PreToolUse', pre],
  [
    'PostToolUse',
    (f, scope) =>
      f.hooks.executePostToolHooks(
        'Read',
        'tool',
        {},
        {},
        f.context,
        undefined,
        undefined,
        undefined,
        scope,
      ),
  ],
  [
    'PostToolUseFailure',
    (f, scope) =>
      f.hooks.executePostToolUseFailureHooks(
        'Read',
        'tool',
        {},
        'failed',
        f.context,
        false,
        undefined,
        undefined,
        undefined,
        scope,
      ),
  ],
  [
    'PermissionDenied',
    (f, scope) =>
      f.hooks.executePermissionDeniedHooks(
        'Read',
        'tool',
        {},
        'denied',
        f.context,
        undefined,
        undefined,
        undefined,
        scope,
      ),
  ],
  [
    'PermissionRequest',
    (f, scope) =>
      f.hooks.executePermissionRequestHooks(
        'Read',
        'tool',
        {},
        f.context,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        scope,
      ),
  ],
  [
    'Stop',
    (f, scope) =>
      f.hooks.executeStopHooks(
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        f.context,
        [],
        undefined,
        undefined,
        scope,
      ),
  ],
  [
    'SubagentStop',
    (f, scope) =>
      f.hooks.executeStopHooks(
        undefined,
        undefined,
        undefined,
        false,
        'subagent' as ToolUseContext['agentId'],
        f.context,
        [],
        'worker',
        undefined,
        scope,
      ),
  ],
  [
    'SessionStart',
    (f, scope) =>
      f.hooks.executeSessionStartHooks(
        'startup',
        'executor-session',
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        scope,
      ),
  ],
  [
    'Setup',
    (f, scope) =>
      f.hooks.executeSetupHooks('init', undefined, undefined, true, scope),
  ],
  [
    'SubagentStart',
    (f, scope) =>
      f.hooks.executeSubagentStartHooks(
        'subagent',
        'worker',
        undefined,
        undefined,
        scope,
      ),
  ],
  [
    'UserPromptSubmit',
    (f, scope) =>
      f.hooks.executeUserPromptSubmitHooks(
        'hello',
        'default',
        f.context,
        undefined,
        scope,
      ),
  ],
]

function populateSources(f: ReturnType<typeof fixture>) {
  f.add('policySettings', 'PreToolUse', 'policy')
  f.add('userSettings', 'PreToolUse', 'user')
  const sdkCalls: string[] = []
  f.registered.PreToolUse = [
    {
      matcher: '',
      hooks: [
        {
          type: 'callback',
          callback: async () => {
            sdkCalls.push('sdk')
            return {}
          },
        },
      ],
    },
    {
      matcher: '',
      pluginRoot: home,
      pluginName: 'fixture',
      hooks: [{ type: 'command', command: 'plugin' }],
    },
  ]
  f.session.addSessionHook(
    (updater) => {
      updater(f.state)
    },
    'executor-session',
    'PreToolUse',
    '',
    { type: 'command', command: 'session' },
  )
  return sdkCalls
}

describe('source-scoped hook executor', () => {
  test('same plugin root retains last-definition dedup even when display names differ', async () => {
    const f = fixture()
    f.registered.PreToolUse = ['first-name', 'last-name'].map((name) => ({
      matcher: '',
      pluginRoot: home,
      pluginName: name,
      hooks: [{ type: 'command', command: 'same' }],
    }))
    const results = await collect(pre(f, 'non-managed'))
    expect(f.calls).toHaveLength(1)
    expect(
      results.every((result) => result.hookSource === 'plugin:last-name'),
    ).toBe(true)
  })

  test('equal command text stays distinct across settings, plugins and skill/session sources', async () => {
    const f = fixture()
    f.add('policySettings', 'PreToolUse', 'same')
    f.add('userSettings', 'PreToolUse', 'same')
    f.registered.PreToolUse = ['one', 'two'].map((name) => ({
      matcher: '',
      pluginRoot: join(home, name),
      pluginName: name,
      hooks: [{ type: 'command', command: 'same' }],
    }))
    const hook: HookCommand = { type: 'command', command: 'same' }
    const successes: string[] = []
    for (const skill of ['one', 'two']) {
      f.session.addSessionHook(
        (updater) => {
          updater(f.state)
        },
        'executor-session',
        'PreToolUse',
        '',
        hook,
        (completed) => {
          expect(completed).toBe(hook)
          successes.push(skill)
        },
        join(home, skill),
      )
    }
    await collect(pre(f))
    expect(f.calls).toHaveLength(6)
    expect(successes.sort()).toEqual(['one', 'two'])
  })

  test('session function hooks remain non-managed and session-local', async () => {
    const f = fixture()
    const calls: string[] = []
    for (const sessionId of ['executor-session', 'foreign']) {
      f.session.addFunctionHook(
        (updater) => {
          updater(f.state)
        },
        sessionId,
        'Stop',
        '',
        async () => {
          calls.push(sessionId)
          return false
        },
        'function block',
      )
    }
    const execute = (scope: HookSourceScope) =>
      f.hooks.executeStopHooks(
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        f.context,
        [],
        undefined,
        undefined,
        scope,
      )
    expect(await collect(execute('managed'))).toEqual([])
    const results = await collect(execute('non-managed'))
    expect(calls).toEqual(['executor-session'])
    expect(results.find((result) => result.blockingError)).toMatchObject({
      hook: { type: 'function' },
      hookSource: 'session',
    })
    f.settings.policySettings = { allowManagedHooksOnly: true }
    expect(await collect(execute('non-managed'))).toEqual([])
  })

  test.each([null, false, 0, ''])(
    'preserves falsy general output %j from command JSON validation',
    async (value) => {
      const f = fixture()
      f.add('policySettings', 'PostToolUse', 'replace')
      f.commands.set('replace', {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: value,
        },
      })
      const results = await collect(
        f.hooks.executePostToolHooks(
          'Read', 'tool', {}, {}, f.context,
          undefined, undefined, undefined, 'managed',
        ),
      )
      const update = results.find(
        (result) => result.updatedToolOutput !== undefined,
      )
      expect(update?.updatedToolOutput).toBe(value)
      expect(update?.hookSource).toBe('policySettings')
    },
  )

  test.each([null, false, 0, ''])(
    'preserves falsy MCP output %j from command JSON validation',
    async (value) => {
      const f = fixture()
      f.add('policySettings', 'PostToolUse', 'replace')
      f.commands.set('replace', {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedMCPToolOutput: value,
        },
      })
      const results = await collect(
        f.hooks.executePostToolHooks(
          'mcp__local__read',
          'tool',
          {},
          {},
          f.context,
          undefined,
          undefined,
          undefined,
          'managed',
        ),
      )
      const update = results.find(
        (result) => result.updatedMCPToolOutput !== undefined,
      )
      expect(update?.updatedMCPToolOutput).toBe(value)
      expect(update?.hookSource).toBe('policySettings')
    },
  )

  test('permission request decisions and denied retries retain hook metadata', async () => {
    const f = fixture()
    f.add('policySettings', 'PermissionRequest', 'permission')
    f.add('policySettings', 'PermissionDenied', 'retry')
    f.commands.set('permission', {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { path: 'new' } },
      },
    })
    f.commands.set('retry', {
      hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
    })
    const requests = await collect(
      f.hooks.executePermissionRequestHooks(
        'Read',
        'tool',
        {},
        f.context,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'managed',
      ),
    )
    expect(
      requests.find((result) => result.permissionRequestResult),
    ).toMatchObject({
      hookSource: 'policySettings',
      hook: { command: 'permission' },
      permissionRequestResult: {
        behavior: 'allow',
        updatedInput: { path: 'new' },
      },
    })
    const denied = await collect(
      f.hooks.executePermissionDeniedHooks(
        'Read',
        'tool',
        {},
        'denied',
        f.context,
        undefined,
        undefined,
        undefined,
        'managed',
      ),
    )
    expect(denied.find((result) => result.retry)).toMatchObject({
      hookSource: 'policySettings',
      hook: { command: 'retry' },
      retry: true,
    })
  })

  test.each(['pending', 'met', 'impossible'] as const)(
    'preserves Goal prompt identity and %s metadata with a local fake evaluator',
    async (outcome) => {
      const f = fixture()
      const goal: HookCommand = { type: 'prompt', prompt: 'finish the goal' }
      f.evaluatorResponse.ok = outcome === 'met'
      f.evaluatorResponse.impossible = outcome === 'impossible'
      f.evaluatorResponse.reason = `goal ${outcome}`
      const successes: unknown[] = []
      f.session.addSessionHook(
        (updater) => {
          updater(f.state)
        },
        'executor-session',
        'Stop',
        '',
        goal,
        (hook) => {
          successes.push(hook)
        },
      )
      const results = await collect(
        f.hooks.executeStopHooks(
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          f.context,
          [],
          undefined,
          undefined,
          'non-managed',
        ),
      )
      expect(results.length).toBeGreaterThanOrEqual(2)
      for (const result of results) {
        expect(result.hook).toBe(goal)
        expect(result.hookSource).toBe('session')
      }
      const completion = results.find((result) => result.stopReason)
      expect(completion?.stopReason).toBe(`goal ${outcome}`)
      expect(Boolean(completion?.blockingError)).toBe(outcome === 'pending')
      expect(Boolean(completion?.impossible)).toBe(outcome === 'impossible')
      expect(successes).toEqual(outcome === 'pending' ? [] : [goal])
    },
  )

  test.each(['allow', 'ask', 'deny'] as const)(
    'retains established %s tie precedence and ignores unrelated later metadata',
    async (decision) => {
      const f = fixture()
      const first: HookCallback = {
        type: 'callback',
        callback: async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: 'first',
          },
        }),
      }
      const next = deferred<SyncHookJSONOutput>()
      const last = deferred<SyncHookJSONOutput>()
      const second: HookCallback = {
        type: 'callback',
        callback: async () => next.promise,
      }
      const unrelated: HookCallback = {
        type: 'callback',
        callback: async () => last.promise,
      }
      f.registered.PreToolUse = [
        { matcher: '', hooks: [first, second, unrelated] },
      ]
      const decisions: AggregatedHookResult[] = []
      for await (const result of pre(f)) {
        if (!result.permissionBehavior) continue
        decisions.push(result)
        if (decisions.length === 1)
          next.resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision,
              permissionDecisionReason: 'second',
            },
          })
        if (decisions.length === 2)
          last.resolve({ systemMessage: 'unrelated diagnostic' })
      }
      const expected = decision === 'allow' ? 'first' : 'second'
      expect(
        decisions.map((result) => result.hookPermissionDecisionReason),
      ).toEqual(['first', expected, expected])
      expect(decisions[2]!.hook).toBe(decision === 'allow' ? first : second)
      expect(
        decisions.every(
          (result) =>
            result.permissionBehavior === decision &&
            result.hookSource === 'sdk',
        ),
      ).toBe(true)
    },
  )

  test.each(invocations)(
    '%s forwards scope and leaves omitted/all compatible',
    async (event, execute) => {
      const f = fixture()
      f.add('policySettings', event, 'policy')
      f.add('userSettings', event, 'user')
      for (const [scope, expected] of [
        [undefined, ['policy', 'user']],
        ['all', ['policy', 'user']],
        ['managed', ['policy']],
        ['non-managed', ['user']],
      ] as const) {
        f.calls.length = 0
        const results = await collect(execute(f, scope))
        expect(f.calls.map((call) => call.command).sort()).toEqual(
          [...expected].sort(),
        )
        expect(
          f.calls.every((call) => call.input.hook_event_name === event),
        ).toBe(true)
        expect(
          results.every((result) => result.hook && result.hookSource),
        ).toBe(true)
      }
    },
  )

  test('non-managed includes enabled settings, SDK, plugin and current-session hooks only', async () => {
    const f = fixture()
    const sdkCalls = populateSources(f)
    f.add('projectSettings', 'PreToolUse', 'project')
    f.add('localSettings', 'PreToolUse', 'local')
    f.add('flagSettings', 'PreToolUse', 'flag')
    f.session.addSessionHook(
      (updater) => {
        updater(f.state)
      },
      'other-session',
      'PreToolUse',
      '',
      { type: 'command', command: 'foreign' },
    )
    const results = await collect(pre(f, 'non-managed'))
    expect(f.calls.map((call) => call.command).sort()).toEqual([
      'flag',
      'local',
      'plugin',
      'project',
      'session',
      'user',
    ])
    expect(sdkCalls).toEqual(['sdk'])
    expect(new Set(results.map((result) => result.hookSource))).toEqual(
      new Set([
        'userSettings',
        'projectSettings',
        'localSettings',
        'flagSettings',
        'sdk',
        'plugin:fixture',
        'session',
      ]),
    )
  })

  test('simultaneous scopes stay isolated while one command is suspended', async () => {
    const f = fixture()
    populateSources(f)
    const entered = deferred<void>()
    const release = deferred<SyncHookJSONOutput>()
    f.commands.set('policy', async () => {
      entered.resolve()
      return release.promise
    })
    const managed = collect(pre(f, 'managed'))
    await entered.promise
    const nonManaged = await collect(pre(f, 'non-managed'))
    expect(
      nonManaged.every((result) => result.hookSource !== 'policySettings'),
    ).toBe(true)
    expect(f.calls.map((call) => call.command).sort()).toEqual([
      'plugin',
      'policy',
      'session',
      'user',
    ])
    release.resolve({})
    expect(
      (await managed).every((result) => result.hookSource === 'policySettings'),
    ).toBe(true)
    expect(f.snapshot.getHooksConfigFromSnapshot()!.PreToolUse).toHaveLength(2)
  })

  test('snapshot captures provenance and nested content until explicit update', async () => {
    const f = fixture()
    f.add('userSettings', 'PreToolUse', 'same')
    f.add('policySettings', 'PreToolUse', 'same')
    f.snapshot.captureHooksConfigSnapshot()
    const captured = f.snapshot.getHooksConfigFromSnapshot()
    expect(
      captured!.PreToolUse!.map((matcher) => matcher.hookSource).sort(),
    ).toEqual(['policySettings', 'userSettings'])
    const hook = f.settings.policySettings!.hooks!.PreToolUse![0]!.hooks[0]!
    if (hook.type === 'command') hook.command = 'changed'
    f.settings.userSettings = { hooks: {} }
    await collect(pre(f, 'managed'))
    await collect(pre(f, 'non-managed'))
    expect(f.calls.map((call) => call.command)).toEqual(['same', 'same'])
    expect(f.snapshot.getHooksConfigFromSnapshot()).toBe(captured)
    f.snapshot.updateHooksConfigSnapshot()
    expect(f.controls.resets).toBe(0)
    f.calls.length = 0
    await collect(pre(f))
    expect(f.calls.map((call) => call.command)).toEqual(['changed'])
  })

  test('trusted project-root transitions reset settings before refreshing hooks', () => {
    const assertResetBeforeSnapshot = (path: string) => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const pairs: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isBlock(node)) {
          const calls = node.statements
            .map((statement) =>
              ts.isExpressionStatement(statement) &&
              ts.isCallExpression(statement.expression) &&
              ts.isIdentifier(statement.expression.expression)
                ? statement.expression.expression.text
                : undefined,
            )
            .filter((name): name is string => name !== undefined)
          if (
            calls.includes('setProjectRoot') &&
            calls.includes('updateHooksConfigSnapshot')
          ) {
            pairs.push(
              calls
                .filter((name) =>
                  name === 'resetSettingsCache' ||
                  name === 'updateHooksConfigSnapshot'
                )
                .join(','),
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      expect(pairs).toEqual(['resetSettingsCache,updateHooksConfigSnapshot'])
    }

    assertResetBeforeSnapshot('../setup.ts')
    assertResetBeforeSnapshot(
      '../tools/ExitWorktreeTool/ExitWorktreeTool.ts',
    )
  })

  test('disabled setting sources are excluded at capture', async () => {
    const f = fixture()
    f.controls.allowed = ['userSettings']
    for (const source of [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const)
      f.add(source, 'PreToolUse', source)
    await collect(pre(f))
    expect(f.calls.map((call) => call.command).sort()).toEqual([
      'flagSettings',
      'policySettings',
      'userSettings',
    ])
  })

  test.each([
    'allowManagedHooksOnly',
    'non-managed-disable',
    'strictPluginOnly',
    'disableAllHooks',
    'untrusted',
    'simple',
  ] as const)('preserves gate %s across all scopes', async (gate) => {
    const f = fixture()
    const sdkCalls = populateSources(f)
    if (gate === 'allowManagedHooksOnly')
      f.settings.policySettings!.allowManagedHooksOnly = true
    if (gate === 'non-managed-disable')
      f.settings.userSettings!.disableAllHooks = true
    if (gate === 'strictPluginOnly')
      f.settings.policySettings!.strictPluginOnlyCustomization = ['hooks']
    if (gate === 'disableAllHooks')
      f.settings.policySettings!.disableAllHooks = true
    if (gate === 'untrusted') f.controls.trusted = false
    if (gate === 'simple') process.env.CLAUDE_CODE_SIMPLE = '1'
    const blocked = ['disableAllHooks', 'untrusted', 'simple'].includes(gate)
    for (const scope of ['all', 'managed', 'non-managed'] as const) {
      f.calls.length = 0
      sdkCalls.length = 0
      await collect(pre(f, scope))
      const expected = blocked
        ? []
        : scope === 'managed'
          ? ['policy']
          : scope === 'non-managed'
            ? []
            : ['policy']
      if (!blocked && gate === 'strictPluginOnly' && scope !== 'managed')
        expected.push('plugin', 'session')
      expect(f.calls.map((call) => call.command).sort()).toEqual(
        expected.sort(),
      )
      expect(sdkCalls).toHaveLength(!blocked && scope !== 'managed' ? 1 : 0)
    }
  })

  test('noninteractive trust exception, live policy disable and internal SDK fast path remain intact', async () => {
    const f = fixture()
    const sdkCalls = populateSources(f)
    f.controls.trusted = false
    f.controls.interactive = false
    await collect(pre(f, 'managed'))
    expect(f.calls).toHaveLength(1)
    f.settings.policySettings!.disableAllHooks = true
    f.calls.length = 0
    expect(await collect(pre(f, 'all'))).toEqual([])
    expect(f.calls).toHaveLength(0)
    delete f.settings.policySettings!.disableAllHooks
    f.settings.userSettings = { hooks: {} }
    f.settings.policySettings = { hooks: {} }
    f.registered.PreToolUse = [f.registered.PreToolUse![0]!]
    const callback = f.registered.PreToolUse[0]!.hooks[0]!
    if (callback.type === 'callback') callback.internal = true
    f.state.sessionHooks.clear()
    f.snapshot.updateHooksConfigSnapshot()
    expect(await collect(pre(f, 'non-managed'))).toEqual([])
    expect(sdkCalls).toEqual(['sdk'])
  })

  test('progress, stop, block, context and diagnostics preserve callback identity and source', async () => {
    const f = fixture()
    const hook: HookCallback = {
      type: 'callback',
      callback: async () => ({
        continue: false,
        stopReason: 'stop now',
        decision: 'block',
        reason: 'blocked',
        systemMessage: 'diagnostic',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: 'context',
        },
      }),
    }
    f.registered.PreToolUse = [{ matcher: '', hooks: [hook] }]
    const results = await collect(pre(f))
    expect(results.some((result) => result.preventContinuation)).toBe(true)
    expect(results.some((result) => result.blockingError)).toBe(true)
    expect(results.some((result) => result.additionalContexts)).toBe(true)
    for (const result of results) {
      expect(result.hook).toBe(hook)
      expect(result.hookSource).toBe('sdk')
    }
  })

  test.each([null, false, 0, ''])(
    'preserves falsy MCP output %j through callback parsing and aggregation',
    async (value) => {
      const f = fixture()
      f.registered.PostToolUse = [
        {
          matcher: '',
          hooks: [
            {
              type: 'callback',
              callback: async () => ({
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse',
                  updatedMCPToolOutput: value,
                },
              }),
            },
          ],
        },
      ]
      const results = await collect(
        f.hooks.executePostToolHooks(
          'mcp__local__read',
          'tool',
          {},
          {},
          f.context,
        ),
      )
      expect(
        results
          .filter((result) => result.updatedMCPToolOutput !== undefined)
          .map((result) => result.updatedMCPToolOutput),
      ).toEqual([value])
    },
  )

  test('repeated aggregate decisions keep the winning reason/source and input rewrites keep their own source', async () => {
    const f = fixture()
    f.add('policySettings', 'PreToolUse', 'deny')
    f.add('userSettings', 'PreToolUse', 'allow')
    f.commands.set('deny', {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy denial',
      },
    })
    const release = deferred<SyncHookJSONOutput>()
    f.commands.set('allow', () => release.promise)
    const results: AggregatedHookResult[] = []
    for await (const result of pre(f)) {
      results.push(result)
      if (result.permissionBehavior === 'deny')
        release.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'user approval',
            updatedInput: { path: 'rewritten' },
          },
        })
    }
    const decisions = results.filter((result) => result.permissionBehavior)
    expect(decisions).toHaveLength(2)
    expect(
      decisions.map((result) => result.hookPermissionDecisionReason),
    ).toEqual(['policy denial', 'policy denial'])
    for (const result of decisions)
      expect(result).toMatchObject({
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'policy denial',
        hookSource: 'policySettings',
        hook: { type: 'command', command: 'deny' },
      })
    expect(results.find((result) => result.updatedInput)).toMatchObject({
      updatedInput: { path: 'rewritten' },
      hookSource: 'userSettings',
      hook: { type: 'command', command: 'allow' },
    })
    expect(results.find((result) => result.blockingError)).toMatchObject({
      hookSource: 'policySettings',
      hook: { type: 'command', command: 'deny' },
    })
  })
  test('equal commands execute once per source, while same-source duplicates still collapse', async () => {
    const f = fixture()
    for (const source of [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      f.add(source, 'PostToolUse', 'same-command')
      f.add(source, 'PostToolUse', 'same-command')
    }
    const results = await collect(
      f.hooks.executePostToolHooks('Read', 'tool', {}, {}, f.context),
    )
    expect(f.calls.map((call) => call.command)).toEqual(
      Array(5).fill('same-command'),
    )
    expect(
      results
        .filter((result) => result.message)
        .map((result) => result.hookSource),
    ).toContain('policySettings')
  })
  test('managed executes only policy settings, not user settings or SDK callbacks', async () => {
    const f = fixture()
    f.add('policySettings', 'PostToolUse', 'policy')
    f.add('userSettings', 'PostToolUse', 'user')
    let sdkCalls = 0
    f.registered.PostToolUse = [
      {
        matcher: '',
        hooks: [
          {
            type: 'callback',
            callback: async () => {
              sdkCalls++
              return {}
            },
          },
        ],
      },
    ]
    await collect(
      f.hooks.executePostToolHooks(
        'Read',
        'tool',
        {},
        {},
        f.context,
        undefined,
        undefined,
        undefined,
        'managed',
      ),
    )
    expect(f.calls.map((call) => call.command)).toEqual(['policy'])
    expect(sdkCalls).toBe(0)
  })
})
