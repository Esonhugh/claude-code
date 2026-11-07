import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearRegisteredHooks,
  registerHookCallbacks,
} from '../bootstrap/state.js'
import { getMatchingHooks } from './hooks.js'
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

describe('apply_patch reaches hooks written for Edit and Write', () => {
  test('Edit and Write matchers, exact or regex, fire for apply_patch; others do not', async () => {
    for (const matcher of ['Edit', 'Write', 'Edit|Write', 'Edit,Bash', '^(Edit|Write)$', 'apply_patch']) {
      clearRegisteredHooks()
      expect(await toolMatches(matcher, 'apply_patch')).toBe(true)
    }
    clearRegisteredHooks()
    expect(await toolMatches('Bash', 'apply_patch')).toBe(false)
    clearRegisteredHooks()
    expect(await toolMatches('apply_patch', 'Edit')).toBe(false)
  })

  test('a hook that matches both names runs once', async () => {
    register('PreToolUse', 'Edit|apply_patch')
    const hooks = await getMatchingHooks(undefined, 'session', 'PreToolUse', {
      session_id: 'session',
      transcript_path: '',
      cwd: '/',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {},
      tool_use_id: 'id',
    } as never)
    expect(hooks.length).toBe(1)
  })

  test('Edit(...) if conditions match any file the patch touches', async () => {
    const { ApplyPatchTool } = await import('../tools/ApplyPatchTool/ApplyPatchTool.js')
    setCachedSettingsForSource('localSettings', {
      hooks: {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'true', if: 'Edit(/tmp/x/*.env)' }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'false', if: 'Edit(/tmp/x/*.md)' }] },
        ],
      },
    } as never)
    resetHooksConfigSnapshot()
    const input = '*** Begin Patch\n*** Update File: /tmp/x/a.py\n-a\n+b\n*** Add File: /tmp/x/b.env\n+K=v\n*** End Patch'
    const hookInput = {
      session_id: 'session',
      transcript_path: '',
      cwd: '/',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { input },
      tool_use_id: 'id',
    }
    ApplyPatchTool.backfillObservableInput!(hookInput.tool_input)
    expect(hookInput.tool_input).toMatchObject({ file_path: '/tmp/x/a.py', file_paths: ['/tmp/x/a.py', '/tmp/x/b.env'] })
    const hooks = await getMatchingHooks(undefined, 'session', 'PreToolUse', hookInput as never, [ApplyPatchTool])
    expect(hooks.map(h => (h.hook as { command?: string }).command)).toEqual(['true'])
  })
})
