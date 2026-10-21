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
