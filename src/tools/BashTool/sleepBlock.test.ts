import { expect, test } from 'bun:test'
import {
  detectBlockedSleepPattern,
  isAutobackgroundingAllowed,
} from './BashTool.js'

// Official 2.1.311 refuses only long foreground sleeps (25s and up).
test('short foreground sleeps run, long ones are refused', () => {
  expect(detectBlockedSleepPattern('sleep 5')).toBeNull()
  expect(detectBlockedSleepPattern('sleep 24.9')).toBeNull()
  expect(detectBlockedSleepPattern('sleep 25')).toBe('standalone sleep 25')
  expect(detectBlockedSleepPattern('sleep 30.5 && curl x')).toBe('sleep 30.5 followed by: curl x')
  expect(detectBlockedSleepPattern('echo a; sleep 60')).toBeNull()
})

test('PowerShell refuses Start-Sleep from 25s, like Bash', async () => {
  const { detectBlockedSleepPattern: detectPs } = await import('../PowerShellTool/PowerShellTool.js')
  expect(detectPs('Start-Sleep 5')).toBeNull()
  expect(detectPs('Start-Sleep -Seconds 25')).toBe('standalone Start-Sleep 25')
  expect(detectPs('sleep 30.5; Get-Date')).toBe('Start-Sleep 30.5 followed by: Get-Date')
})

// Like 2.1.311 the first word decides, so `sleep 5` times out instead of
// being moved to the background.
test('a timed-out sleep is not auto-backgrounded', () => {
  expect(isAutobackgroundingAllowed('sleep 5')).toBe(false)
  expect(isAutobackgroundingAllowed('sleep 3 && echo z')).toBe(false)
  expect(isAutobackgroundingAllowed('npm test')).toBe(true)
  expect(isAutobackgroundingAllowed('')).toBe(true)
})

// Official 325 skips the leading-sleep block under shellWallCapMs (an async
// REPL script call); the sleep then runs and stops at its timeout.
test('the leading-sleep block is skipped in the async REPL lane', async () => {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const { sleepBlockMessage } = await import('./BashTool.js')
  const input = { command: 'sleep 30 && echo done' }
  expect(sleepBlockMessage(input, {})).toStartWith('Blocked: sleep 30 followed by: echo done.')
  expect(sleepBlockMessage(input, { shellWallCapMs: 7_200_000 })).toBeNull()
  expect(sleepBlockMessage({ ...input, run_in_background: true }, {})).toBeNull()
})

test('the leading Start-Sleep block is skipped in the async REPL lane', async () => {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const { sleepBlockMessage } = await import('../PowerShellTool/PowerShellTool.js')
  const input = { command: 'Start-Sleep -Seconds 30; Get-Date' }
  expect(sleepBlockMessage(input, {})).toStartWith('Blocked: Start-Sleep 30 followed by: Get-Date.')
  expect(sleepBlockMessage(input, { shellWallCapMs: 7_200_000 })).toBeNull()
  expect(sleepBlockMessage({ ...input, run_in_background: true }, {})).toBeNull()
})

test.skipIf(process.platform === 'win32')('in the async REPL lane a leading sleep stops at its timeout instead of moving to the background', async () => {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { BashTool } = await import('./BashTool.js')
  const { ShellError } = await import('../../utils/errors.js')
  const initial = getDefaultAppState()
  const state = { ...initial, toolPermissionContext: { ...initial.toolPermissionContext, mode: 'bypassPermissions' as const } }
  const context = {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    options: { isNonInteractiveSession: true },
    replScriptCall: true,
    shellWallCapMs: 7_200_000,
  }
  const started = Date.now()
  const failure = BashTool.call({ command: 'sleep 30', timeout: 500 } as never, context as never)
  const error = await failure.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(ShellError)
  expect(Date.now() - started).toBeLessThan(10_000)
})
