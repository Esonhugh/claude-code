import assert from 'node:assert/strict'

import { clearGoalStatusAfterStopHooksPassForTesting } from './stopHooks.js'

let clearedState = {
  goalStatus: { active: true },
}
clearGoalStatusAfterStopHooksPassForTesting({
  getAppState: () => clearedState,
  setAppState: updater => {
    clearedState = updater(clearedState)
  },
} as never)
assert.deepEqual(clearedState.goalStatus, { active: false })

let inactiveSetCalls = 0
clearGoalStatusAfterStopHooksPassForTesting({
  getAppState: () => ({ goalStatus: { active: false } }),
  setAppState: () => {
    inactiveSetCalls += 1
  },
} as never)
assert.equal(inactiveSetCalls, 0)

console.log('stopHooks.test.ts passed')
