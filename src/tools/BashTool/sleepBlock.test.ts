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
