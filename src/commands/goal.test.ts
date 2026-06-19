import assert from 'node:assert/strict'

import type { PromptCommand } from '../types/command.js'
import goal from './goal.js'

const goalCommand = goal as PromptCommand

type GoalState = {
  goalStatus: { active: boolean }
}

function createContext(initial: GoalState) {
  let state = initial
  return {
    context: {
      setAppState: (updater: (prev: GoalState) => GoalState) => {
        state = updater(state)
      },
    } as never,
    getState: () => state,
  }
}

const setContext = createContext({ goalStatus: { active: false } })
await goalCommand.getPromptForCommand('  finish the feature  ', setContext.context)
assert.deepEqual(setContext.getState().goalStatus, { active: true })

const emptyContext = createContext({ goalStatus: { active: false } })
await goalCommand.getPromptForCommand('', emptyContext.context)
assert.deepEqual(emptyContext.getState().goalStatus, { active: true })

const clearContext = createContext({
  goalStatus: { active: true },
})
await goalCommand.getPromptForCommand(' clear ', clearContext.context)
assert.deepEqual(clearContext.getState().goalStatus, { active: false })

console.log('goal.test.ts passed')
