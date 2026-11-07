import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../bootstrap/state.js'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executePostToolHooks, executePreToolHooks, getMatchingHooks } from './hooks.js'
import { resetHooksConfigSnapshot } from './hooks/hooksConfigSnapshot.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settings/settingsCache.js'

beforeEach(() => {
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
})

function register(event: 'PreToolUse' | 'SubagentStart', matcher: string) {
  registerHookCallbacks({
    [event]: [
      { matcher, hooks: [{ type: 'callback', callback: async () => ({}) }] },
    ],
  })
}

async function toolMatches(matcher: string, toolName: string) {
  register('PreToolUse', matcher)
  const hooks = await getMatchingHooks(undefined, 'session', 'PreToolUse', {
    session_id: 'session',
    transcript_path: '',
    cwd: '/',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: 'id',
  } as never)
  return hooks.length > 0
}

describe('hook matchers with hyphens and commas (official 2.1.191 / 2.1.195)', () => {
  test('a hyphenated MCP server name matches exactly, not as a substring', async () => {
    expect(await toolMatches('mcp__brave-search', 'mcp__brave-search__web')).toBe(false)
    clearRegisteredHooks()
    expect(await toolMatches('mcp__brave-search', 'mcp__brave-search')).toBe(true)
  })

  test('the documented server-wide pattern still matches its tools', async () => {
    expect(
      await toolMatches('mcp__brave-search__.*', 'mcp__brave-search__web'),
    ).toBe(true)
  })

  test('comma-separated matchers fire for each listed tool', async () => {
    expect(await toolMatches('Bash,PowerShell', 'Bash')).toBe(true)
    clearRegisteredHooks()
    expect(await toolMatches('Bash, Write', 'Write')).toBe(true)
    clearRegisteredHooks()
    expect(await toolMatches('Bash,PowerShell', 'Read')).toBe(false)
  })

  test('hyphenated agent types match exactly for SubagentStart', async () => {
    register('SubagentStart', 'code-reviewer')
    const input = (agent_type: string) =>
      ({
        session_id: 'session',
        transcript_path: '',
        cwd: '/',
        hook_event_name: 'SubagentStart',
        agent_id: 'a',
        agent_type,
      }) as never
    expect(
      await getMatchingHooks(undefined, 'session', 'SubagentStart', input('code-reviewer-2')),
    ).toHaveLength(0)
    expect(
      await getMatchingHooks(undefined, 'session', 'SubagentStart', input('code-reviewer')),
    ).toHaveLength(1)
  })
})

describe('an empty match value only reaches matcher-less hooks (official 2.1.275)', () => {
  test('SubagentStop with an empty agent type skips agent-specific matchers', async () => {
    register('SubagentStart', 'code-reviewer')
    registerHookCallbacks({
      SubagentStop: [
        { matcher: 'code-reviewer', hooks: [{ type: 'callback', callback: async () => ({}) }] },
        { hooks: [{ type: 'callback', callback: async () => ({}) }] },
      ],
    })
    const hooks = await getMatchingHooks(undefined, 'session', 'SubagentStop', {
      session_id: 'session',
      transcript_path: '',
      cwd: '/',
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'a',
      agent_type: '',
      agent_transcript_path: '',
    } as never)
    expect(hooks).toHaveLength(1)
  })
})

describe('apply_patch runs Edit and Write hooks once per file', () => {
  // Non-interactive, so hooks run without the workspace trust dialog.
  beforeEach(() => setIsInteractive(false))
  afterEach(() => setIsInteractive(true))
  const ctx = {
    getAppState: () => ({ toolPermissionContext: { mode: 'default' }, sessionHooks: new Map() }),
    abortController: new AbortController(),
    options: { tools: [] },
  } as never

  function recordingHook(matcher: string | undefined, seen: string[], decide?: (input: Record<string, unknown>) => object) {
    return {
      ...(matcher !== undefined && { matcher }),
      hooks: [
        {
          type: 'callback' as const,
          callback: async (input: never) => {
            const { tool_name, tool_input } = input as { tool_name: string; tool_input: Record<string, unknown> }
            seen.push(`${matcher ?? '-'} ${tool_name} ${String(tool_input.file_path ?? '').split('/').pop()}`)
            return (decide?.(tool_input) ?? {}) as never
          },
        },
      ],
    }
  }

  function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'apply-patch-hooks-'))
    writeFileSync(join(dir, 'a.py'), 'a\n')
    writeFileSync(join(dir, 'old.txt'), 'o\n')
    writeFileSync(join(dir, 'gone.txt'), 'g\n')
    return dir
  }

  test('each file runs the Edit or Write hooks as its own call; patch-wide hooks run once', async () => {
    const dir = tempDir()
    const seen: string[] = []
    registerHookCallbacks({
      PreToolUse: [
        recordingHook('Edit', seen),
        recordingHook('Write', seen),
        recordingHook('Edit|apply_patch', seen),
        recordingHook('*', seen),
        recordingHook(undefined, seen),
        recordingHook('Bash', seen),
      ],
    })
    const input = [
      '*** Begin Patch',
      `*** Update File: ${dir}/a.py`,
      '-a',
      '+b',
      `*** Add File: ${dir}/b.env`,
      '+K=v',
      `*** Update File: ${dir}/old.txt`,
      `*** Move to: ${dir}/new.txt`,
      `*** Delete File: ${dir}/gone.txt`,
      '*** End Patch',
    ].join('\n')
    for await (const _ of executePreToolHooks('apply_patch', 'id', { input }, ctx)) {
      // drain
    }
    expect(seen.sort()).toEqual(
      [
        '* apply_patch ',
        '- apply_patch ',
        'Edit|apply_patch apply_patch ',
        'Edit Edit a.py',
        'Write Write b.env',
        'Write Write new.txt',
        'Edit Edit old.txt',
        'Edit Edit gone.txt',
      ].sort(),
    )
  })

  test('a per-file deny blocks the patch, but a per-file allow or rewrite does not carry over', async () => {
    const dir = tempDir()
    const seen: string[] = []
    registerHookCallbacks({
      PreToolUse: [
        recordingHook('Edit', seen, () => ({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { file_path: 'x' } },
        })),
        recordingHook('Write', seen, toolInput =>
          String(toolInput.file_path).endsWith('.env') ? { decision: 'block', reason: 'no .env' } : {},
        ),
      ],
    })
    const input = `*** Begin Patch\n*** Update File: ${dir}/a.py\n-a\n+b\n*** Add File: ${dir}/b.env\n+K=v\n*** End Patch`
    const results = []
    for await (const result of executePreToolHooks('apply_patch', 'id', { input }, ctx)) results.push(result)
    expect(seen).toEqual(['Edit Edit a.py', 'Write Write b.env'])
    expect(results.some(r => r.permissionBehavior === 'allow' || r.updatedInput)).toBe(false)
    expect(results.find(r => r.blockingError)?.blockingError?.blockingError).toContain('no .env')
  })

  test('PostToolUse gives each file its Edit or Write input and response', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.py'), 'b\n')
    writeFileSync(join(dir, 'b.env'), 'K=v\n')
    const inputs: unknown[] = []
    registerHookCallbacks({
      PostToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [
            {
              type: 'callback',
              callback: async (input: never) => {
                const { tool_name, tool_input, tool_response } = input as Record<string, unknown>
                inputs.push({ tool_name, tool_input, tool_response })
                return {} as never
              },
            },
          ],
        },
      ],
    })
    const output = {
      files: [
        { type: 'update', filePath: `${dir}/a.py`, originalFile: 'a\n', structuredPatch: [] },
        { type: 'add', filePath: `${dir}/b.env`, originalFile: '', structuredPatch: [] },
      ],
    }
    for await (const _ of executePostToolHooks('apply_patch', 'id', { input: '' }, output, ctx)) {
      // drain
    }
    expect(inputs).toEqual([
      {
        tool_name: 'Edit',
        tool_input: { file_path: `${dir}/a.py`, old_string: 'a\n', new_string: 'b\n', replace_all: false },
        tool_response: expect.objectContaining({ filePath: `${dir}/a.py`, oldString: 'a\n', newString: 'b\n' }),
      },
      {
        tool_name: 'Write',
        tool_input: { file_path: `${dir}/b.env`, content: 'K=v\n' },
        tool_response: expect.objectContaining({ type: 'create', filePath: `${dir}/b.env`, content: 'K=v\n' }),
      },
    ])
  })

  test('Edit matchers no longer match apply_patch itself', async () => {
    expect(await toolMatches('Edit|Write', 'apply_patch')).toBe(false)
    clearRegisteredHooks()
    expect(await toolMatches('apply_patch', 'apply_patch')).toBe(true)
  })
})
