import { afterEach, beforeEach, expect, test } from 'bun:test'
import { clearRegisteredHooks, registerHookCallbacks, setIsInteractive } from '../bootstrap/state.js'
import { executeWorktreeCreateHook } from './hooks.js'
import { resetHooksConfigSnapshot } from './hooks/hooksConfigSnapshot.js'
import { resetSettingsCache, setSessionSettingsCache } from './settings/settingsCache.js'

// Non-interactive, so hooks run without the workspace trust dialog.
beforeEach(() => {
  setIsInteractive(false)
  clearRegisteredHooks()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  setSessionSettingsCache({ settings: {}, errors: [] })
})
afterEach(() => {
  setIsInteractive(true)
  clearRegisteredHooks()
  resetHooksConfigSnapshot()
  resetSettingsCache()
})

test('a WorktreeCreate hook that succeeds without a path says so (official 2.1.329)', async () => {
  registerHookCallbacks({
    WorktreeCreate: [{ hooks: [{ type: 'callback', callback: async () => ({}) }] }],
  })
  await expect(executeWorktreeCreateHook('wt1')).rejects.toThrow(
    'WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)',
  )
})

test('a WorktreeCreate hook that returns a path is used', async () => {
  registerHookCallbacks({
    WorktreeCreate: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async () => ({
              hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath: '/tmp/wt1' },
            }),
          },
        ],
      },
    ],
  })
  expect(await executeWorktreeCreateHook('wt1')).toEqual({ worktreePath: '/tmp/wt1' })
})
